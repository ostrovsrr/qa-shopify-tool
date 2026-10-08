import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../../src/db/prisma';
import {
  purgeExpiredPii,
  REDACTED_ISSUE_NOTE,
  RETENTION_DAYS,
} from '../../src/services/retention.service';
import { getValidationResult } from '../../src/services/customerValidation.service';
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

  // ── THE SECOND SAFETY CATCH ───────────────────────────────────────────────

  it('REFUSES to purge an existing database until a human has confirmed', async () => {
    const id = await seedValidation(ancient());

    // This is what actually went wrong: the purge ran on a routine boot and deleted
    // 47 real runs before anyone knew it existed. Even with retention deliberately
    // switched on, the FIRST sweep that would destroy something now stops, prints how
    // many runs it is about to gut, and waits to be told yes.
    const previous = process.env.RETENTION_CONFIRMED;
    delete process.env.RETENTION_CONFIRMED;
    try {
      const summary = await purgeExpiredPii();

      expect(summary.validationRuns).toBe(0);
      expect(await rowsFor(id)).toBe(2); // untouched
      const run = await prisma.validationRun.findUniqueOrThrow({ where: { id } });
      expect(run.piiPurgedAt).toBeNull();
    } finally {
      process.env.RETENTION_CONFIRMED = previous;
    }

    // Confirmed → it proceeds. The gate is a gate, not a wall.
    expect((await purgeExpiredPii()).validationRuns).toBe(1);
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

  // ── THE FINDINGS QUOTE THE DATA ───────────────────────────────────────────
  // Deleting the rows is not enough if the issues table keeps a copy: currentValue
  // is the raw cell, and messages embed it ('Email "..." appears in rows: 2, 3').

  it('strips the values the findings quote, for customers', async () => {
    const id = await seedValidation(ancient());
    await prisma.validationIssue.create({
      data: {
        validationRunId: id,
        rowNumber: 3,
        columnName: 'Email',
        severity: 'Error',
        issueType: 'DuplicateEmail',
        currentValue: 'jane@acme.com',
        message: 'Email "jane@acme.com" appears in rows: 2, 3. Shopify keeps one customer per email.',
        suggestedFix: 'Remove or correct the duplicate email address.',
      },
    });

    await purgeExpiredPii();

    const result = await getValidationResult(id);
    expect(JSON.stringify(result)).not.toContain('jane@acme.com');
    const dup = result!.issues.find((i) => i.issueType === 'DuplicateEmail')!;
    // What the history still needs survives: where, and what kind of problem.
    expect(dup).toMatchObject({ rowNumber: 3, column: 'Email', currentValue: '' });
    expect(dup.message).toBe(`DuplicateEmail in Email. ${REDACTED_ISSUE_NOTE}`);
    // A static fix quotes nothing, so it stays.
    expect(dup.suggestedFix).toBe('Remove or correct the duplicate email address.');
  });

  it('strips the values the findings quote, for products (the twin)', async () => {
    const id = await seedUpload(ancient());
    await prisma.productValidationIssue.create({
      data: {
        uploadRunId: id,
        rowNumber: 1,
        handle: 'alpha',
        columnName: 'Option2 Name',
        severity: 'Error',
        issueType: 'OptionGap',
        currentValue: 'Secret Option',
        message: 'Option2 Name is "Secret Option" but Option1 Name is blank.',
        suggestedFix: 'Move "Secret Option" into Option1 Name.',
      },
    });

    await purgeExpiredPii();

    const issue = await prisma.productValidationIssue.findFirstOrThrow({ where: { uploadRunId: id } });
    expect(JSON.stringify(issue)).not.toContain('Secret Option');
    expect(issue).toMatchObject({
      currentValue: null,
      message: `OptionGap in Option2 Name. ${REDACTED_ISSUE_NOTE}`,
      suggestedFix: null,
      issueType: 'OptionGap',
      rowNumber: 1,
    });
  });

  it('leaves the findings of an in-flight run untouched', async () => {
    const id = await seedValidation(ancient(), 'RUNNING');
    await prisma.validationIssue.updateMany({
      where: { validationRunId: id },
      data: { currentValue: 'jane@acme.com' },
    });

    await purgeExpiredPii();

    const issue = await prisma.validationIssue.findFirstOrThrow({ where: { validationRunId: id } });
    expect(issue.currentValue).toBe('jane@acme.com');
  });
});
