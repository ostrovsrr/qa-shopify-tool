import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../../src/db/prisma';
import { resetDb } from './resetDb';
import {
  reconcileImportRun,
  startBatchImport,
  startCustomerImport,
} from '../../src/services/shopifyImport.service';

// ─────────────────────────────────────────────────────────────────────────────
// THE CUSTOMER HALF of the batch-rollup regression suite.
//
// The customers and products flows are twins: same fan-out, same batch parent +
// jobs, same reconcile-on-poll rollup, same bug. batchRollup.test.ts covers
// products; this covers customers. A fix applied to only one half leaves the
// other half carrying the bug — and because the two are so similar, it reads as
// done when it isn't.
//
// The bug: reconcileBatchRun rolls the parent up when every job it FINDS IN THE
// DB is terminal. That check cannot tell "all 5 jobs finished" apart from "only 2
// jobs were ever written, and both finished." Jobs written as they complete +
// a crash mid-fan-out (a redeploy) = a parent that claims COMPLETED while three
// stores never received a single customer.
//
// The fix: pre-persist ALL N jobs as PENDING in the parent's transaction, before
// any Shopify call. PENDING is not terminal, so unstarted jobs hold the rollup
// open.
// ─────────────────────────────────────────────────────────────────────────────

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const truncateAll = resetDb;

/** A validation run with two customer rows, enough to split across stores. */
async function seedValidation(): Promise<string> {
  const validationId = uuidv4();
  await prisma.validationRun.create({
    data: {
      id: validationId,
      fileName: 'customers.csv',
      fileType: 'CUSTOMER',
      totalRows: 2,
      errors: 0,
      warnings: 0,
      info: 0,
      originalRows: {
        create: [
          {
            id: uuidv4(),
            rowNumber: 2,
            data: { 'First Name': 'Ann', 'Last Name': 'Lee', Email: 'ann@example.com' },
          },
          {
            id: uuidv4(),
            rowNumber: 3,
            data: { 'First Name': 'Bob', 'Last Name': 'Ray', Email: 'bob@example.com' },
          },
        ],
      },
    },
  });
  return validationId;
}

/** Build a parent import run whose jobs sit in the given states — i.e. the exact
 *  DB state a given crash or completion scenario leaves behind. */
async function seedRun(validationId: string, statuses: string[]): Promise<string> {
  const parentId = uuidv4();
  await prisma.importRun.create({
    data: {
      id: parentId,
      validationId,
      storeId: null, // correct for a batch parent: it spans many stores
      shopDomain: 'a.myshopify.com, b.myshopify.com',
      bulkOperationId: null,
      status: 'RUNNING',
      successCount: 0,
      errorCount: 0,
      batchJobs: {
        create: statuses.map((status, i) => ({
          id: uuidv4(),
          storeId: `store${i + 1}`,
          shopDomain: `s${i + 1}.myshopify.com`,
          batchIndex: i,
          batchCount: statuses.length,
          // A COMPLETED job has an op id; a PENDING one never got that far.
          bulkOperationId: status === 'PENDING' ? null : `gid://shopify/BulkOperation/${i}`,
          status,
          rowCount: 1,
        })),
      },
    },
  });
  return parentId;
}

const parentStatus = async (id: string): Promise<string> =>
  (await prisma.importRun.findUniqueOrThrow({ where: { id } })).status;

runIf('customer batch rollup — never claim an import succeeded when it did not', () => {
  beforeEach(truncateAll);
  afterAll(async () => {
    await truncateAll();
    await prisma.$disconnect();
  });

  // ── THE REGRESSION TEST ────────────────────────────────────────────────────
  it('does NOT roll up to COMPLETED when jobs are still PENDING (crash mid-fan-out)', async () => {
    const validationId = await seedValidation();
    const parentId = await seedRun(validationId, [
      'COMPLETED',
      'COMPLETED',
      'PENDING',
      'PENDING',
      'PENDING',
    ]);

    await reconcileImportRun(parentId);

    // The three stores that never received a customer are still on disk and still
    // non-terminal, so they hold the rollup open.
    expect(await parentStatus(parentId)).toBe('RUNNING');
    expect(await parentStatus(parentId)).not.toBe('COMPLETED');
  });

  // ── WHY THE FIX HAS TO BE AT WRITE TIME ────────────────────────────────────
  // Asserts the WRONG answer on purpose: with only the completed jobs on disk,
  // the rollup cannot detect the missing stores. Nothing at read time can.
  it('WOULD lie if only the completed jobs were persisted (the bug pre-persist prevents)', async () => {
    const validationId = await seedValidation();
    const parentId = await seedRun(validationId, ['COMPLETED', 'COMPLETED']);

    await reconcileImportRun(parentId);

    expect(await parentStatus(parentId)).toBe('COMPLETED');
  });

  it('rolls up to COMPLETED when every job really did complete', async () => {
    const validationId = await seedValidation();
    const parentId = await seedRun(validationId, ['COMPLETED', 'COMPLETED', 'COMPLETED']);

    await reconcileImportRun(parentId);

    expect(await parentStatus(parentId)).toBe('COMPLETED');
  });

  it('rolls up to FAILED when a job failed, and names the store', async () => {
    const validationId = await seedValidation();
    const parentId = await seedRun(validationId, ['COMPLETED', 'FAILED']);

    await reconcileImportRun(parentId);

    const run = await prisma.importRun.findUniqueOrThrow({ where: { id: parentId } });
    expect(run.status).toBe('FAILED');
    expect(run.error).toContain('s2.myshopify.com');
  });

  it('a single PENDING job among terminal ones is enough to hold the rollup open', async () => {
    const validationId = await seedValidation();
    const parentId = await seedRun(validationId, ['COMPLETED', 'FAILED', 'PENDING']);

    await reconcileImportRun(parentId);

    expect(await parentStatus(parentId)).toBe('RUNNING');
  });
});

runIf('startBatchImport — every job is on disk before Shopify is touched', () => {
  beforeEach(truncateAll);
  afterAll(async () => {
    await truncateAll();
    await prisma.$disconnect();
  });

  // setEnv.ts strips SHOPIFY_*, so every store here is genuinely unreachable and
  // each launch fails at getShopifyClient. The rows must exist anyway — a missing
  // row is precisely what lets the parent lie.
  it('persists all N jobs even when every store fails to launch', async () => {
    const validationId = await seedValidation();

    const result = await startBatchImport(validationId, ['store1', 'store2', 'store3']);
    expect(result).toMatchObject({ ok: true });
    const importRunId = (result as { importRunId: string }).importRunId;

    const jobs = await prisma.importBatchJob.findMany({
      where: { importRunId },
      orderBy: { batchIndex: 'asc' },
    });

    // Two rows across three stores → the third gets an empty batch and is skipped.
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.status).toBe('FAILED');
      expect(job.batchCount).toBe(3);
      expect(job.rowCount).toBe(1);
    }

    // The batch parent's storeId stays NULL: it spans many stores.
    const parent = await prisma.importRun.findUniqueOrThrow({ where: { id: importRunId } });
    expect(parent.storeId).toBeNull();
  });

  // The single-store path has the same rule. It used to submit the bulk op and
  // THEN create the run row; a crash in between left customers landing in a real
  // store with no DB row, tagged with an importRunId that existed only in memory.
  // (The ordering itself is proven in prePersistOrdering.test.ts.)
  it('single-store: an unreachable store leaves no orphan run behind', async () => {
    const validationId = await seedValidation();

    await expect(startCustomerImport(validationId, 'store1')).rejects.toThrow(/configured/i);

    const runs = await prisma.importRun.findMany({ where: { validationId } });
    expect(runs).toHaveLength(0);
  });
});
