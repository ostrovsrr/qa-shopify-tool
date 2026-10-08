import prisma from '../db/prisma';
import { getShopifyStoresConfig } from '../config/shopify';
import { TERMINAL_BULK_STATUSES } from './shopifyBulk';
import { instanceOwnsStore } from './importReconcile';
import { failAbandonedSubmits } from './importResume.service';
import { STORE_LOCK_TTL_MS } from './storeLock.service';
import { reconcileImportRun } from './shopifyImport.service';
import { reconcileProductImportRun } from './productImport.service';

// ─────────────────────────────────────────────────────────────────────────────
// ADVANCE IMPORTS NOBODY IS WATCHING.
//
// Imports finalize on POLL: GET /api/customer-import/:id (and the product twin)
// calls reconcile, which asks Shopify whether the bulk operation is done and
// finalizes the run if it is. That is the whole mechanism — crash recovery
// deliberately leaves a relaunched row RUNNING for it to finish.
//
// Which is fine while somebody is looking. An import whose watcher walked away —
// closed tab, went to a meeting, browser slept — sits RUNNING with Shopify long
// since finished: it reads as still-running in everyone's shared history, and it
// holds that store's busy-lock until the 30-minute TTL expires, blocking the next
// import to the same shop.
//
// Observed, not theorised: a real 14,229-row customer import sat RUNNING for over
// two hours holding a lock, and finalized in three seconds the moment anything
// polled it — 14,174 imported, 19 rejected. Nothing was broken; nobody had looked.
//
// cleanupRun.service.ts already solved exactly this for cleanups
// (sweepRunningCleanups, called every 60s from index.ts). Imports never got the
// equivalent. This is that, for the customer and product flows, which are twins.
// ─────────────────────────────────────────────────────────────────────────────

/** One sweepable run: a single-store run, or a batch parent with its jobs' stores. */
interface SweepRow {
  id: string;
  storeId: string | null;
  batchJobs: { storeId: string | null }[];
}

/**
 * Only touch runs this instance has a stake in.
 *
 * One instance per Solution Engineer against a SHARED database, so this sweep sees
 * every colleague's runs too. A single-store run is ours when its store is (see
 * instanceOwnsStore). A batch parent has no store of its own — its stores live on
 * its jobs — so it is ours when ANY of its jobs' stores is: this instance advances
 * those jobs, and the reconcile skips the rest (never fails them) and leaves them to
 * the colleague whose stores they are.
 */
function ownsRun(row: SweepRow): boolean {
  if (row.batchJobs.length > 0) return row.batchJobs.some((j) => instanceOwnsStore(j.storeId));
  return instanceOwnsStore(row.storeId);
}

async function sweep(
  label: string,
  rows: SweepRow[],
  reconcile: (id: string) => Promise<unknown>,
): Promise<void> {
  for (const row of rows) {
    if (!ownsRun(row)) continue;
    // One unreachable store must not stop the rest from being reconciled.
    try {
      await reconcile(row.id);
    } catch (err) {
      console.error(`[import-sweep] ${label} ${row.id}:`, (err as Error).message);
    }
  }
}

/**
 * What a run must look like to be swept: non-terminal, and either holding a bulk
 * operation id (a single-store run Shopify is working on) or being a batch parent.
 *
 * A batch parent never has an op id of its own — its ops live on its jobs — so
 * filtering on bulkOperationId alone skipped every batch, and a batch whose watcher
 * walked away sat RUNNING holding every one of its stores. Its PENDING jobs are
 * still left to resume: reconcileBatchRun only polls jobs that have an op id.
 *
 * A single-store run without an op id has not reached Shopify yet and belongs to
 * resumePendingImports, not here. Reconciling it would be a no-op at best and a
 * duplicate submit at worst.
 */
const SWEEPABLE = {
  status: { notIn: TERMINAL_BULK_STATUSES },
  OR: [{ bulkOperationId: { not: null } }, { batchJobs: { some: {} } }],
};
const SWEEP_SELECT = { id: true, storeId: true, batchJobs: { select: { storeId: true } } };

/** Settles an ambiguous submit once its store lock has run out. */
const ABANDONED_SUBMIT_ERROR =
  'Submit outcome unknown: Shopify never confirmed this import was submitted, so it may or ' +
  'may not have run. Check the store for its qa-import records and run QA cleanup if any ' +
  'are there before re-running.';

/**
 * Fail rows whose submit came back ambiguous (or whose process died mid-submit) and
 * that nobody has settled since. They are left PENDING on purpose so their store
 * stays held while an op may be running (see recordAmbiguousSubmit); once the lock's
 * TTL has passed, the same "outcome unknown" verdict resume-on-boot would give is
 * recorded here, so a batch parent waiting on such a job can finally roll up.
 */
async function failAbandoned(now: number): Promise<void> {
  // Strictly our own stores. Unlike a reconcile — which cannot fail anything for
  // want of a client — this writes FAILED, so an instance that cannot judge
  // ownership (no usable store list) settles nothing and leaves it to the owner.
  const config = getShopifyStoresConfig();
  if (!config.ok || config.stores.length === 0) return;
  const before = new Date(now - STORE_LOCK_TTL_MS);
  const delegates = [
    prisma.importRun,
    prisma.importBatchJob,
    prisma.productImportRun,
    prisma.productImportJob,
  ];
  for (const delegate of delegates) {
    try {
      await failAbandonedSubmits(delegate as never, before, ABANDONED_SUBMIT_ERROR, instanceOwnsStore);
    } catch (err) {
      console.error('[import-sweep] settling abandoned submits:', (err as Error).message);
    }
  }
}

/** Advance every non-terminal import that has reached Shopify. */
export async function sweepRunningImports(now: number = Date.now()): Promise<void> {
  await failAbandoned(now);

  const customerRuns = await prisma.importRun.findMany({ where: SWEEPABLE, select: SWEEP_SELECT });
  const productRuns = await prisma.productImportRun.findMany({ where: SWEEPABLE, select: SWEEP_SELECT });

  await sweep('customer', customerRuns, reconcileImportRun);
  await sweep('product', productRuns, reconcileProductImportRun);
}
