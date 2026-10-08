import prisma from '../db/prisma';
import { sweepOwnsStore } from '../config/shopify';
import { TERMINAL_BULK_STATUSES } from './shopifyBulk';
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

/** Only rows for stores THIS instance holds credentials for — see sweepOwnsStore. */
async function sweep<T extends { id: string; storeId: string | null }>(
  label: string,
  rows: T[],
  reconcile: (id: string) => Promise<unknown>,
): Promise<void> {
  for (const row of rows) {
    if (!sweepOwnsStore(row.storeId)) continue;
    // One unreachable store must not stop the rest from being reconciled.
    try {
      await reconcile(row.id);
    } catch (err) {
      console.error(`[import-sweep] ${label} ${row.id}:`, (err as Error).message);
    }
  }
}

/**
 * Advance every non-terminal import that already has a bulk operation id.
 *
 * Requires bulkOperationId: a row without one has not reached Shopify yet and
 * belongs to resumePendingImports, not here. Reconciling it would be a no-op at
 * best and a duplicate submit at worst.
 */
export async function sweepRunningImports(): Promise<void> {
  const customerRuns = await prisma.importRun.findMany({
    where: {
      status: { notIn: TERMINAL_BULK_STATUSES },
      bulkOperationId: { not: null },
    },
    select: { id: true, storeId: true },
  });

  const productRuns = await prisma.productImportRun.findMany({
    where: {
      status: { notIn: TERMINAL_BULK_STATUSES },
      bulkOperationId: { not: null },
    },
    select: { id: true, storeId: true },
  });

  await sweep('customer', customerRuns, reconcileImportRun);
  await sweep('product', productRuns, reconcileProductImportRun);
}
