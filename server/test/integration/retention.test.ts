import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../../src/db/prisma';
import { purgeExpiredPii, RETENTION_DAYS } from '../../src/services/retention.service';
import { resetDb } from './resetDb';

// ─────────────────────────────────────────────────────────────────────────────
// PII RETENTION, AND THE RULE THAT KEEPS IT FROM BREAKING THE TOOL.
//
// The tool stores merchant customer data — names, emails, phones, addresses — and
// until now nothing ever deleted any of it.
//
// The obvious policy ("delete runs older than N days") is a P0 bug here, because
// OriginalCustomerRow / ProductOriginalRow are NOT an archive. They are a LIVE
// DEPENDENCY: the reconcile rebuilds the import dataset from them to map Shopify's
// bulk results back to CSV rows, the Excel reports are built from them, and
// resume-on-boot recomputes a job's slice from them. Delete them out from under a
// RUNNING import and the tool cannot tell the truth about an import that is
// happening right now.
//
// So we purge the SOURCE ROWS (the PII) and keep the AGGREGATE RESULTS (counts,
// per-row-number outcomes — no personal data). And a run with any non-terminal
// import is never touched, however old it is.
//
// The in-flight test below is the one that matters. Everything else is bookkeeping.
// ─────────────────────────────────────────────────────────────────────────────

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const ancient = (): Date => new Date(Date.now() - (RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000);
const recent = (): Date => new Date();

async function seedValidation(createdAt: Date, importStatus?: string): Promise<string> {
  const id = uuidv4();
  await prisma.validationRun.create({
    data: {
      id,
      createdAt,
      fileName: 'customers.csv',
      fileType: 'CUSTOMER',
      totalRows: 2,
      errors: 1,
      warnings: 0,
      info: 0,
      affectedRows: [{ rowNumber: 2, data: { Email: 'jane@acme.com' } }],
      originalRows: {
        create: [
          { id: uuidv4(), rowNumber: 2, data: { Email: 'jane@acme.com', 'First Name': 'Jane' } },
          { id: uuidv4(), rowNumber: 3, data: { Email: 'bob@acme.com', 'First Name': 'Bob' } },
        ],
      },
      issues: {
        create: [
          {
            id: uuidv4(),
            rowNumber: 2,
            columnName: 'Email',
            severity: 'Error',
            issueType: 'InvalidEmail',
            message: 'bad',
          },
        ],
      },
    },
  });

  if (importStatus) {
    await prisma.importRun.create({
      data: {
        id: uuidv4(),
        validationId: id,
        storeId: 'store1',
        shopDomain: 'fake.myshopify.com',
        status: importStatus,
        successCount: 0,
        errorCount: 0,
      },
    });
  }
  return id;
}

async function seedUpload(createdAt: Date, importStatus?: string): Promise<string> {
  const id = uuidv4();
  await prisma.productUploadRun.create({
    data: {
      id,
      createdAt,
      fileName: 'products.csv',
      productCount: 1,
      originalRows: {
        create: [{ id: uuidv4(), rowNumber: 1, data: { Handle: 'alpha', Title: 'Alpha' } }],
      },
    },
  });
  if (importStatus) {
    await prisma.productImportRun.create({
      data: {
        id: uuidv4(),
        uploadId: id,
        storeId: 'store1',
        shopDomain: 'fake.myshopify.com',
        status: importStatus,
        successCount: 0,
        errorCount: 0,
      },
    });
  }
  return id;
}

const rowsFor = (validationRunId: string) =>
  prisma.originalCustomerRow.count({ where: { validationRunId } });

runIf('PII retention', () => {
  beforeEach(resetDb);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── THE COMPANION RULE ────────────────────────────────────────────────────

  it('NEVER purges a run whose import is still in flight, however old it is', async () => {
    const id = await seedValidation(ancient(), 'RUNNING');

    const summary = await purgeExpiredPii();

    // These rows are not history — they are the input to work that has not finished.
    // The reconcile rebuilds the import dataset from them to map Shopify's results
    // back to CSV rows. Purge them and the import can never be reconciled, and can
    // never tell anyone what it did.
    expect(summary.skippedInFlight).toBe(1);
    expect(summary.validationRuns).toBe(0);
    expect(await rowsFor(id)).toBe(2);
    const run = await prisma.validationRun.findUniqueOrThrow({ where: { id } });
    expect(run.piiPurgedAt).toBeNull();
  });

  it('purges an old run once its import has finished', async () => {
    const id = await seedValidation(ancient(), 'COMPLETED');

    const summary = await purgeExpiredPii();

    expect(summary.validationRuns).toBe(1);
    expect(await rowsFor(id)).toBe(0);
  });

  // ── what survives, and what does not ──────────────────────────────────────

  it('purges the raw rows but KEEPS the aggregate results', async () => {
    const id = await seedValidation(ancient());

    await purgeExpiredPii();

    const run = await prisma.validationRun.findUniqueOrThrow({
      where: { id },
      include: { issues: true, originalRows: true },
    });

    // Gone: the personal data.
    expect(run.originalRows).toHaveLength(0);
    // affectedRows is a JSON snapshot of the flagged CSV rows — it is PII too, and
    // keeping it would defeat the entire exercise.
    expect(run.affectedRows).toEqual([]);

    // Kept: the QA answer. Counts and issue types carry no personal data, and they
    // are the reason anyone looks at an old run at all.
    expect(run.errors).toBe(1);
    expect(run.issues).toHaveLength(1);
    expect(run.issues[0].issueType).toBe('InvalidEmail');

    // And it is marked, so the UI can say the report is no longer available rather
    // than offering a download that would fail.
    expect(run.piiPurgedAt).not.toBeNull();
  });

  it('leaves runs inside the retention window alone', async () => {
    const id = await seedValidation(recent());

    const summary = await purgeExpiredPii();

    expect(summary.validationRuns).toBe(0);
    expect(await rowsFor(id)).toBe(2);
  });

  it('does not purge the same run twice', async () => {
    await seedValidation(ancient());

    expect((await purgeExpiredPii()).validationRuns).toBe(1);
    // piiPurgedAt is set, so the second pass finds nothing to do — the sweep runs
    // daily and must not churn through every old run forever.
    expect((await purgeExpiredPii()).validationRuns).toBe(0);
  });

  // ── the twin ──────────────────────────────────────────────────────────────

  it('applies the same rules to product uploads', async () => {
    const inFlight = await seedUpload(ancient(), 'RUNNING');
    const done = await seedUpload(ancient(), 'COMPLETED');

    const summary = await purgeExpiredPii();

    expect(summary.productUploads).toBe(1);
    expect(await prisma.productOriginalRow.count({ where: { uploadRunId: inFlight } })).toBe(1);
    expect(await prisma.productOriginalRow.count({ where: { uploadRunId: done } })).toBe(0);
  });
});
