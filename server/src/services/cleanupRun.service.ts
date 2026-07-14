import { v4 as uuidv4 } from 'uuid';
import type { CleanupRun } from '@prisma/client';
import prisma from '../db/prisma';
import { getShopifyConfig, resolveStoreId } from '../config/shopify';
import { getShopifyClient } from './shopifyClient';
import {
  acquireStoreLock,
  releaseStoreLock,
  renewStoreLock,
  StoreBusyError,
} from './storeLock.service';
import {
  BulkDeleteSpec,
  fetchBulkOperationState,
  MAX_JOB_POLL_ATTEMPTS,
  parseBulkDeleteResults,
  submitBulkDelete,
  TERMINAL_BULK_STATUSES,
} from './shopifyBulk';
import { customerCleanupAdapter } from './shopifyCleanup.service';
import { productCleanupAdapter } from './productCleanup.service';
import {
  adoptRow,
  claimRow,
  failRow,
  findResumableRows,
  ResumableStore,
} from './importResume.service';

// ─────────────────────────────────────────────────────────────────────────────
// ASYNC CLEANUP.
//
// Cleanup used to run entirely inside the HTTP request, polling Shopify for up to
// 300 SECONDS (150 attempts x 2s — deliberately, per the old comment). That is
// fine on localhost and impossible hosted: a platform proxy gives up around 100s,
// so the request dies while the delete is still running and the user is told
// nothing at all. These are also the highest-blast-radius routes in the app — they
// delete by tag across an entire store.
//
// Cleanup is now a persisted run, advanced one step per poll, exactly like an
// import. Same rules as everywhere else in this codebase:
//   - the row is written BEFORE the delete is submitted (never take a side effect
//     you have not recorded),
//   - a PENDING row is resumable on boot,
//   - customers and products are twins and share one engine.
// ─────────────────────────────────────────────────────────────────────────────

export type CleanupEntity = 'CUSTOMER' | 'PRODUCT';

interface CleanupAdapter {
  entity: CleanupEntity;
  bulkThreshold: number;
  fetchIdsByTag(
    storeId: string | undefined,
    tag: string,
  ): Promise<{ shop: string; ids: string[] }>;
  serialDelete(
    client: Awaited<ReturnType<typeof getShopifyClient>>,
    ids: string[],
  ): Promise<{ deleted: number; errors: { id: string; message: string }[] }>;
  deleteSpec: BulkDeleteSpec;
}

function adapterFor(entity: CleanupEntity): CleanupAdapter {
  return entity === 'CUSTOMER' ? customerCleanupAdapter : productCleanupAdapter;
}

/**
 * Start a cleanup of one store.
 *
 * Small teardowns (<= bulkThreshold ids) still run inline: ~50 sequential deletes
 * take a couple of seconds, well inside any proxy timeout, and paying the
 * staged-upload + poll cost for them would be slower. Anything bigger is submitted
 * as a bulk operation and left to the poll to finish.
 *
 * Either way the row lands FIRST. A crash between submitting the delete and saving
 * its operation id would otherwise leave records being deleted from a real store
 * with no record that it ever happened.
 */
export async function startCleanupRun(
  entity: CleanupEntity,
  storeId: string | undefined,
  tag: string,
  importRunId?: string,
): Promise<CleanupRun> {
  const adapter = adapterFor(entity);
  const runId = uuidv4();

  // ── Take the store's busy-lock and write the row in ONE transaction, BEFORE we
  //    so much as list what we are about to delete.
  //
  //    This is the route the lock was really built for. An import to this store may
  //    be in flight right now, and cleanup deletes BY TAG across the WHOLE store —
  //    it would delete the very records that import is about to reconcile against,
  //    and the run would then report nonsense. Shopify's one-bulk-op-per-shop limit
  //    does NOT cover us here: the small-teardown path below deletes serially, not
  //    as a bulk operation, so Shopify sees nothing to reject. This lock is the only
  //    thing in the way.
  //
  //    Listing the ids first and locking second would leave the list to go stale
  //    under a concurrent import, so the lock comes first and the id list is taken
  //    while we hold the store.
  try {
    await prisma.$transaction(async (tx) => {
      await acquireStoreLock(tx, resolveStoreId(storeId) ?? storeId ?? 'default', {
        ownerType: 'CLEANUP_RUN',
        ownerId: runId,
        operation: entity === 'CUSTOMER' ? 'a customer cleanup' : 'a product cleanup',
      });
      await tx.cleanupRun.create({
        data: {
          id: runId,
          entity,
          storeId: storeId ?? null,
          shopDomain: shopDomainFor(storeId),
          tag,
          importRunId: importRunId ?? null,
          status: 'PENDING',
          found: 0,
        },
      });
    });
  } catch (err) {
    if (err instanceof StoreBusyError) {
      // Record the refusal as a FAILED run rather than throwing: the caller may have
      // asked for several stores at once, and the ones that ARE free should still be
      // cleaned. The user sees exactly which store was busy.
      return prisma.cleanupRun.create({
        data: {
          entity,
          storeId: storeId ?? null,
          shopDomain: shopDomainFor(storeId),
          tag,
          importRunId: importRunId ?? null,
          status: 'FAILED',
          error: err.message.slice(0, 500),
        },
      });
    }
    throw err;
  }

  try {
    const { shop, ids } = await adapter.fetchIdsByTag(storeId, tag);
    await prisma.cleanupRun.update({
      where: { id: runId },
      data: { shopDomain: shop, found: ids.length, submittedIds: ids },
    });

    // Nothing tagged: done before we started.
    if (ids.length === 0) {
      const done = await prisma.cleanupRun.update({
        where: { id: runId },
        data: { status: 'COMPLETED', deleted: 0, failedCount: 0 },
      });
      await releaseStoreLock(runId);
      return done;
    }

    const client = await getShopifyClient(storeId);

    if (ids.length <= adapter.bulkThreshold) {
      const { deleted, errors } = await adapter.serialDelete(client, ids);
      const done = await prisma.cleanupRun.update({
        where: { id: runId },
        data: {
          status: 'COMPLETED',
          deleted,
          failedCount: errors.length,
          errors: errors.length > 0 ? (errors as unknown as object[]) : undefined,
        },
      });
      // The serial path finishes inside this request, so the store is free now.
      await releaseStoreLock(runId);
      return done;
    }

    // The bulk path outlives this request; the lock is held until the poll that
    // reconciles it to terminal (reconcileCleanupRun) hands it back.
    const bulkOpId = await submitBulkDelete(client, ids, adapter.deleteSpec);
    return await prisma.cleanupRun.update({
      where: { id: runId },
      data: { status: 'RUNNING', bulkOperationId: bulkOpId },
    });
  } catch (err) {
    const message = (err as Error).message;
    const failed = await prisma.cleanupRun.update({
      where: { id: runId },
      data: { status: 'FAILED', error: message.slice(0, 500) },
    });
    await releaseStoreLock(runId);
    return failed;
  }
}

/** Shop domain from env config, without touching the network — so the row (and its
 *  lock) can be written before we talk to Shopify at all. */
function shopDomainFor(storeId: string | undefined): string {
  const result = getShopifyConfig(storeId);
  return result.ok ? result.config.shop : (storeId ?? 'unknown');
}

/** Start a cleanup against several stores at once (a batch import touched many). */
export async function startCleanupRuns(
  entity: CleanupEntity,
  storeIds: (string | undefined)[],
  tag: string,
  importRunId?: string,
): Promise<CleanupRun[]> {
  return Promise.all(
    storeIds.map((storeId) => startCleanupRun(entity, storeId, tag, importRunId)),
  );
}

/**
 * Advance a cleanup by AT MOST ONE step. Called by the status poll, so a 300s
 * delete costs a handful of cheap requests instead of one that outlives the proxy.
 */
export async function reconcileCleanupRun(id: string): Promise<CleanupRun | null> {
  const run = await prisma.cleanupRun.findUnique({ where: { id } });
  if (!run) return null;
  if (TERMINAL_BULK_STATUSES.includes(run.status)) return run;
  // PENDING means the submit never landed — resume-on-boot owns that, not the poll.
  if (!run.bulkOperationId) return run;

  // Bound a stuck operation the same way the import reconcile does.
  const attempts = run.pollAttempts + 1;
  if (attempts > MAX_JOB_POLL_ATTEMPTS) {
    const failed = await prisma.cleanupRun.update({
      where: { id },
      data: {
        status: 'FAILED',
        error: `Timed out: still running after ${MAX_JOB_POLL_ATTEMPTS} status checks.`,
      },
    });
    await releaseStoreLock(id);
    return failed;
  }
  await prisma.cleanupRun.update({ where: { id }, data: { pollAttempts: attempts } });

  const adapter = adapterFor(run.entity as CleanupEntity);
  const client = await getShopifyClient(run.storeId ?? undefined);
  const state = await fetchBulkOperationState(client, run.bulkOperationId);

  // Still deleting — leave it RUNNING and let the next poll look again.
  if (!TERMINAL_BULK_STATUSES.includes(state.status)) {
    // Still being watched, so keep holding the store.
    await renewStoreLock(id);
    return prisma.cleanupRun.findUnique({ where: { id } });
  }

  const finish = async (data: Parameters<typeof prisma.cleanupRun.update>[0]['data']) => {
    const done = await prisma.cleanupRun.update({ where: { id }, data });
    // Terminal — the store is free.
    await releaseStoreLock(id);
    return done;
  };

  if (state.status !== 'COMPLETED') {
    return finish({
      status: state.status,
      error: `Bulk delete ${state.status}${state.errorCode ? ` (${state.errorCode})` : ''}.`,
    });
  }

  if (!state.url) {
    // COMPLETED with no result file means Shopify deleted nothing to report.
    return finish({ status: 'COMPLETED', deleted: 0, failedCount: 0 });
  }

  // The ids were persisted at submit time because the result file maps back to them
  // BY LINE, and this reconcile runs in a different request than the submit did.
  const ids = (run.submittedIds ?? []) as string[];
  const { deleted, errors } = await parseBulkDeleteResults(state.url, ids, adapter.deleteSpec);

  return finish({
    status: 'COMPLETED',
    deleted,
    failedCount: errors.length,
    errors: errors.length > 0 ? (errors as unknown as object[]) : undefined,
  });
}

export async function getCleanupRun(id: string): Promise<CleanupRun | null> {
  return prisma.cleanupRun.findUnique({ where: { id } });
}

/** Every cleanup a given import run kicked off, newest first. */
export async function getCleanupRunsForImport(importRunId: string): Promise<CleanupRun[]> {
  return prisma.cleanupRun.findMany({
    where: { importRunId },
    orderBy: { createdAt: 'desc' },
  });
}

// ── crash recovery ───────────────────────────────────────────────────────────

/** Re-submit a cleanup whose bulk delete never reached Shopify. */
async function relaunchCleanupRun(id: string): Promise<void> {
  const run = await prisma.cleanupRun.findUnique({ where: { id } });
  if (!run) return;

  const adapter = adapterFor(run.entity as CleanupEntity);
  const ids = (run.submittedIds ?? []) as string[];
  if (ids.length === 0) {
    await prisma.cleanupRun.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'COMPLETED', deleted: 0 },
    });
    return;
  }

  const client = await getShopifyClient(run.storeId ?? undefined);
  const bulkOpId = await submitBulkDelete(client, ids, adapter.deleteSpec);
  await prisma.cleanupRun.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'RUNNING', bulkOperationId: bulkOpId },
  });
}

/**
 * A cleanup interrupted between "row written" and "delete submitted" is resumed
 * like any other PENDING row: adopt the operation if it actually reached Shopify,
 * re-submit if it did not. Deleting twice is harmless (the records are already
 * gone), but adopting is still right — it recovers the real deleted/failed counts
 * instead of reporting zero.
 */
export function cleanupResumableStores(): ResumableStore[] {
  return [
    {
      label: 'cleanup',
      findResumable: (staleBefore) => findResumableRows(prisma.cleanupRun as never, staleBefore),
      claim: (id, staleBefore) => claimRow(prisma.cleanupRun as never, id, staleBefore),
      adopt: (id, bulkOperationId) => adoptRow(prisma.cleanupRun as never, id, bulkOperationId),
      relaunch: relaunchCleanupRun,
      fail: (id, error) => failRow(prisma.cleanupRun as never, id, error),
      lockOwner: (row) => ({
        ownerType: 'CLEANUP_RUN',
        ownerId: row.id,
        operation: 'a cleanup',
      }),
    },
  ];
}
