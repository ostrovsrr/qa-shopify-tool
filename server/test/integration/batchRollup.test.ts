import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../../src/db/prisma';
import {
  reconcileProductImportRun,
  startBatchProductImport,
  startProductImport,
} from '../../src/services/productImport.service';

// ─────────────────────────────────────────────────────────────────────────────
// THE REGRESSION SUITE FOR THE BUG THAT MAKES THE TOOL LIE.
//
// A batch import fans out across N stores. The parent run rolls up to COMPLETED
// when `fresh.every(j => TERMINAL.includes(j.status))` over the jobs it finds IN
// THE DATABASE. That every() is trusting: it cannot tell "all 5 jobs finished"
// apart from "only 2 jobs were ever written, and both finished."
//
// So if jobs are persisted AS THEY COMPLETE, a crash mid-fan-out (a redeploy,
// which auto-deploy-on-merge makes routine) leaves 2 of 5 rows on disk, the
// rollup agrees they are all terminal, and the parent goes COMPLETED. The Excel
// report then tells a colleague every product imported when three stores never
// received anything.
//
// The fix is at WRITE time, not read time: pre-persist ALL N jobs as PENDING in
// the same transaction as the parent, before any Shopify call. PENDING is not
// terminal, so the unstarted jobs hold the rollup open.
//
// A QA tool that confidently lies is worse than one that crashes.
// ─────────────────────────────────────────────────────────────────────────────

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "product_upload_runs" RESTART IDENTITY CASCADE',
  );
}

/** An upload with two products, enough to split across stores. */
async function seedUpload(): Promise<string> {
  const uploadId = uuidv4();
  await prisma.productUploadRun.create({
    data: {
      id: uploadId,
      fileName: 'products.csv',
      productCount: 2,
      originalRows: {
        create: [
          { id: uuidv4(), rowNumber: 1, data: { Handle: 'alpha', Title: 'Alpha' } },
          { id: uuidv4(), rowNumber: 2, data: { Handle: 'beta', Title: 'Beta' } },
        ],
      },
    },
  });
  return uploadId;
}

/**
 * Build a parent run with `statuses.length` jobs in the given states — i.e. the
 * exact DB state some crash or completion scenario leaves behind.
 */
async function seedRun(uploadId: string, statuses: string[]): Promise<string> {
  const parentId = uuidv4();
  await prisma.productImportRun.create({
    data: {
      id: parentId,
      uploadId,
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
          productCount: 1,
        })),
      },
    },
  });
  return parentId;
}

const parentStatus = async (id: string): Promise<string> =>
  (await prisma.productImportRun.findUniqueOrThrow({ where: { id } })).status;

runIf('batch rollup — the tool must never claim an import succeeded when it did not', () => {
  beforeEach(truncateAll);
  afterAll(async () => {
    await truncateAll();
    await prisma.$disconnect();
  });

  // ── THE REGRESSION TEST ────────────────────────────────────────────────────
  // This is the state a redeploy mid-fan-out leaves under the fix: 5 jobs on
  // disk, 2 of them finished, 3 never started. The parent MUST NOT roll up.
  it('does NOT roll up to COMPLETED when jobs are still PENDING (crash mid-fan-out)', async () => {
    const uploadId = await seedUpload();
    const parentId = await seedRun(uploadId, [
      'COMPLETED',
      'COMPLETED',
      'PENDING',
      'PENDING',
      'PENDING',
    ]);

    await reconcileProductImportRun(parentId);

    // The three stores that never received anything are still on disk and still
    // non-terminal, so they hold the rollup open.
    expect(await parentStatus(parentId)).toBe('RUNNING');
    expect(await parentStatus(parentId)).not.toBe('COMPLETED');
  });

  // ── WHY THE FIX HAS TO BE AT WRITE TIME ────────────────────────────────────
  // Same crash, but jobs written only as they complete (the OLD shape): the two
  // unstarted stores have no row at all. The rollup sees two terminal jobs,
  // agrees, and LIES. This test documents the bug the pre-persist prevents — it
  // asserts the wrong answer on purpose, to show the rollup cannot defend itself.
  it('WOULD lie if only the completed jobs were persisted (the bug pre-persist prevents)', async () => {
    const uploadId = await seedUpload();
    // Only 2 rows — as if stores 3-5 crashed before their jobs were ever written.
    const parentId = await seedRun(uploadId, ['COMPLETED', 'COMPLETED']);

    await reconcileProductImportRun(parentId);

    // every() over {COMPLETED, COMPLETED} is true. The parent claims success.
    // Nothing at read time can detect the three missing stores — which is exactly
    // why all N jobs must be on disk BEFORE the fan-out starts.
    expect(await parentStatus(parentId)).toBe('COMPLETED');
  });

  // ── THE HAPPY PATH MUST STILL WORK ─────────────────────────────────────────
  it('rolls up to COMPLETED when every job really did complete', async () => {
    const uploadId = await seedUpload();
    const parentId = await seedRun(uploadId, ['COMPLETED', 'COMPLETED', 'COMPLETED']);

    await reconcileProductImportRun(parentId);

    expect(await parentStatus(parentId)).toBe('COMPLETED');
  });

  it('rolls up to FAILED when a job failed, and names the store', async () => {
    const uploadId = await seedUpload();
    const parentId = await seedRun(uploadId, ['COMPLETED', 'FAILED']);

    await reconcileProductImportRun(parentId);

    const run = await prisma.productImportRun.findUniqueOrThrow({ where: { id: parentId } });
    expect(run.status).toBe('FAILED');
    expect(run.error).toContain('s2.myshopify.com');
  });

  it('a single PENDING job among terminal ones is enough to hold the rollup open', async () => {
    const uploadId = await seedUpload();
    const parentId = await seedRun(uploadId, ['COMPLETED', 'FAILED', 'PENDING']);

    await reconcileProductImportRun(parentId);

    expect(await parentStatus(parentId)).toBe('RUNNING');
  });
});

runIf('startBatchProductImport — every job is on disk before Shopify is touched', () => {
  beforeEach(truncateAll);
  afterAll(async () => {
    await truncateAll();
    await prisma.$disconnect();
  });

  // If the fan-out blows up on EVERY store, all N job rows must STILL EXIST.
  //
  // Under the old code the rows were only created AFTER the fan-out, so a total
  // failure produced a run with no jobs at all — and that same write-ordering is
  // exactly what let a PARTIAL failure roll up to COMPLETED. Persisting the plan
  // first is the invariant; this test is what holds it.
  //
  // setEnv.ts strips SHOPIFY_* so every store here is genuinely unreachable and
  // the launch fails at getShopifyClient. The rows must be on disk anyway.
  it('persists all N jobs even when every store fails to launch', async () => {
    const uploadId = await seedUpload();

    const result = await startBatchProductImport(uploadId, ['store1', 'store2', 'store3']);
    expect(result).toMatchObject({ ok: true });
    const importRunId = (result as { importRunId: string }).importRunId;

    const jobs = await prisma.productImportJob.findMany({
      where: { importRunId },
      orderBy: { batchIndex: 'asc' },
    });

    // Two products across three stores → the third store gets an empty batch and
    // is correctly skipped. The two that DO have work are both on disk.
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      // Shopify is unreachable, so each job launched into FAILED — but the ROW
      // exists, which is the whole point. A missing row is what lets the parent lie.
      expect(job.status).toBe('FAILED');
      expect(job.batchCount).toBe(3);
      expect(job.productCount).toBe(1);
    }

    // The batch parent's storeId stays NULL: it spans many stores. Forcing it
    // NOT NULL would write a false store id.
    const parent = await prisma.productImportRun.findUniqueOrThrow({
      where: { id: importRunId },
    });
    expect(parent.storeId).toBeNull();
  });

  // ── THE SINGLE-STORE PATH HAS THE SAME RULE ────────────────────────────────
  // It used to submit the bulk op to Shopify and THEN create the run row. A crash
  // in between left products landing in a real store with no DB row at all: the
  // run invisible, the products tagged with an importRunId that existed only in
  // memory, so the run-scoped cleanup could never find them.
  //
  // Never take a side effect you have not recorded.
  it('single-store: refuses to submit before the run row exists', async () => {
    const uploadId = await seedUpload();

    // Shopify is unreachable here (setEnv strips SHOPIFY_*), so the launch fails
    // at getShopifyClient — BEFORE any bulk op could be submitted. Nothing is
    // created in any store, and no orphan run is left behind.
    await expect(startProductImport(uploadId, 'store1')).rejects.toThrow(/configured/i);

    const runs = await prisma.productImportRun.findMany({ where: { uploadId } });
    expect(runs).toHaveLength(0);
  });
});
