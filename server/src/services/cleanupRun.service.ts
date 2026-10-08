import { v4 as uuidv4 } from 'uuid';
import type { CleanupOp, CleanupRun, Prisma } from '@prisma/client';
import prisma from '../db/prisma';
import { getShopifyConfig, sweepOwnsStore } from '../config/shopify';
import { getShopifyClient } from './shopifyClient';
import {
  acquireStoreLock,
  releaseStoreLock,
  renewStoreLock,
  StoreBusyError,
} from './storeLock.service';
import {
  BulkConcurrencyLimitError,
  BulkDeleteFailure,
  BulkDeleteSpec,
  fetchBulkOperationState,
  MAX_JOB_POLL_ATTEMPTS,
  opsForStoreOnShop,
  parseBulkDeleteResults,
  splitIntoBatches,
  submitBulkDelete,
  TERMINAL_BULK_STATUSES,
} from './shopifyBulk';
import { customerCleanupAdapter } from './shopifyCleanup.service';
import { productCleanupAdapter } from './productCleanup.service';
import {
  claimRow,
  failRow,
  findResumableRows,
  markSubmitAttempt,
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
//
// K DELETES PER STORE. A big teardown is split across up to BULK_OPS_PER_STORE
// concurrent Shopify bulk deletes (cleanup_ops) — measured 3.6x faster with five
// than with one. The CleanupRun stays one row per store: it owns the store lock
// (CLEANUP_RUN, its id), holds the listed ids, and carries the totals once every op
// is terminal (rollUpCleanupRun). A RUNNING row with bulkOperationId set predates
// the split and is still reconciled the old way (reconcileSingleOpRun).
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

  // A run with no store recorded cannot be cleaned up: there is nowhere to delete
  // from. This only reaches us via a LEGACY row written before storeId was required
  // (when an absent store silently meant "the first one"). Guessing a store and
  // deleting by tag from it is the single worst thing this code could do, so say so
  // instead.
  if (!storeId) {
    return prisma.cleanupRun.create({
      data: {
        entity,
        storeId: null,
        shopDomain: 'unknown',
        tag,
        importRunId: importRunId ?? null,
        status: 'FAILED',
        error: 'This run has no store recorded, so its records cannot be cleaned up automatically.',
      },
    });
  }

  // ── Take the store's busy-lock and write the row in ONE transaction, BEFORE we
  //    so much as list what we are about to delete.
  //
  //    This is the route the lock was really built for. An import to this store may
  //    be in flight right now, and cleanup deletes BY TAG across the WHOLE store —
  //    it would delete the very records that import is about to reconcile against,
  //    and the run would then report nonsense. Shopify's per-shop bulk-op limit
  //    does NOT cover us here: from API 2026-01 it admits up to five concurrent bulk
  //    mutations per shop anyway, and the small-teardown path below deletes serially,
  //    not as a bulk operation, so Shopify sees nothing to reject. This lock is the
  //    only thing in the way.
  //
  //    Listing the ids first and locking second would leave the list to go stale
  //    under a concurrent import, so the lock comes first and the id list is taken
  //    while we hold the store.
  try {
    await prisma.$transaction(async (tx) => {
      await acquireStoreLock(tx, storeId, {
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
    const inline = ids.length <= adapter.bulkThreshold;
    await prisma.cleanupRun.update({
      where: { id: runId },
      // The bulk path writes submittedIds together with its ops (launchCleanupOps),
      // so a crash between the two leaves "never listed" for resume to re-list,
      // never a list with no ops to delete it.
      data: { shopDomain: shop, found: ids.length, ...(inline ? { submittedIds: ids } : {}) },
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

    if (inline) {
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
    // rolls the last op up to terminal (reconcileCleanupRun) hands it back.
    await launchCleanupOps(runId, client, ids, adapter);
    return await prisma.cleanupRun.findUniqueOrThrow({ where: { id: runId } });
  } catch (err) {
    // Only a run still PENDING is ours to fail here: nothing was submitted for it
    // (every Shopify submit happens per op, after the run went RUNNING), so the store
    // is provably idle and can be handed back. A RUNNING run's outcome belongs to its
    // ops — a DB error after they were submitted must not fail the run and release
    // the store under live deletes; the poll and the sweep roll it up.
    const message = (err as Error).message;
    const { count } = await prisma.cleanupRun.updateMany({
      where: { id: runId, status: 'PENDING' },
      data: { status: 'FAILED', error: message.slice(0, 500) },
    });
    if (count === 1) await releaseStoreLock(runId);
    return prisma.cleanupRun.findUniqueOrThrow({ where: { id: runId } });
  }
}

/** Error text for a delete that may have reached Shopify — the user is the only one
 *  who can look at the store, so say what to check. */
function outcomeUnknownMessage(cause: string): string {
  return `The delete may or may not have reached Shopify (${cause}). Check the store, and re-run cleanup if tagged records remain.`;
}

/**
 * Split a PENDING run's ids into k ops, record them, and submit them all at once.
 *
 * submittedIds, the run's move to RUNNING and the k PENDING op rows land in ONE
 * transaction, before anything is sent to Shopify: a crash after it leaves PENDING
 * ops for resume to relaunch, a crash before it leaves a PENDING run with no ops,
 * which resume re-lists (relaunchCleanupRun). Never a submitted op with no row.
 *
 * Each op deletes splitIntoBatches(ids, k)[opIndex], which the reconcile recomputes
 * from (opIndex, opCount) to map its result file back by line — so the split must
 * stay a pure function of the persisted ids and k.
 *
 * Guarded on the run still being PENDING, so a run another process already launched
 * is not launched twice.
 */
async function launchCleanupOps(
  runId: string,
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  ids: string[],
  adapter: CleanupAdapter,
  listed: Prisma.CleanupRunUpdateManyMutationInput = {},
): Promise<void> {
  // Capped by the bulk ops already running on the shop (an orphan from a crash, a
  // colleague's import), so one op's submit does not fail on the per-shop limit.
  const k = await opsForStoreOnShop(client, ids.length);
  const ops = Array.from({ length: k }, (_, opIndex) => ({
    id: uuidv4(),
    cleanupRunId: runId,
    opIndex,
    opCount: k,
  }));

  const launched = await prisma.$transaction(async (tx) => {
    const { count } = await tx.cleanupRun.updateMany({
      where: { id: runId, status: 'PENDING' },
      data: { ...listed, submittedIds: ids, status: 'RUNNING' },
    });
    if (count !== 1) return false;
    await tx.cleanupOp.createMany({ data: ops });
    return true;
  });
  if (!launched) return;

  const slices = splitIntoBatches(ids, k);
  // allSettled: launchCleanupOp records its own failures, so a rejection here is
  // the DB failing us mid-record. That op stays PENDING for resume; the others must
  // still be recorded, and the roll-up still run.
  const results = await Promise.allSettled(
    ops.map((op) => launchCleanupOp(op.id, client, slices[op.opIndex], adapter.deleteSpec)),
  );
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error(`[cleanup] ${runId}: could not record an op's submit:`, (r.reason as Error).message);
    }
  }
  // If every op already failed at submit, the run finishes now.
  await rollUpCleanupRun(runId);
}

/**
 * Submit one op's slice and record the outcome. Never throws for a Shopify failure:
 * every one ends the op RUNNING or FAILED.
 *
 * Which FAILED matters to the store lock (see rollUpCleanupRun):
 *   - DEFINITE — the throw came before the mutation call (submitAttemptedAt never
 *     written), or Shopify answered with a refusal that started nothing
 *     (BulkConcurrencyLimitError). submitAttemptedAt is cleared, so the op reads as
 *     "nothing running".
 *   - OUTCOME UNKNOWN — the mutation call itself failed (a dropped connection or a
 *     gateway error says nothing about whether the op landed), or Shopify returned
 *     an op id and RECORDING it failed. submitAttemptedAt stays set with no op id —
 *     the state storeLock's judgeHolder treats as possibly still running.
 */
async function launchCleanupOp(
  opId: string,
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  slice: string[],
  spec: BulkDeleteSpec,
): Promise<void> {
  // Set the moment Shopify hands back an op id. A throw after that is not a refused
  // submit — the op exists and may be deleting right now.
  let bulkOpId: string | null = null;
  try {
    bulkOpId = await submitBulkDelete(client, slice, spec, () =>
      markSubmitAttempt(prisma.cleanupOp as never, opId),
    );
    await prisma.cleanupOp.updateMany({
      where: { id: opId, status: 'PENDING' },
      data: { status: 'RUNNING', bulkOperationId: bulkOpId },
    });
  } catch (err) {
    const message = (err as Error).message;
    if (bulkOpId) {
      await prisma.cleanupOp
        .updateMany({
          where: { id: opId, status: 'PENDING' },
          data: {
            status: 'FAILED',
            error: outcomeUnknownMessage(
              `Shopify started ${bulkOpId}; recording it failed: ${message}`,
            ).slice(0, 500),
          },
        })
        .catch(() => undefined); // the DB just failed us once; PENDING + attempted is also "unknown"
      return;
    }
    const attempted = await prisma.cleanupOp.findUnique({
      where: { id: opId },
      select: { submitAttemptedAt: true },
    });
    const definite = !attempted?.submitAttemptedAt || err instanceof BulkConcurrencyLimitError;
    await prisma.cleanupOp.updateMany({
      where: { id: opId, status: 'PENDING' },
      data: {
        status: 'FAILED',
        error: (definite ? message : outcomeUnknownMessage(message)).slice(0, 500),
        ...(definite ? { submitAttemptedAt: null } : {}),
      },
    });
  }
}

/** FAILED while submitting, with no op id: the delete may be running at Shopify.
 *  The same test storeLock's judgeHolder applies to a lock holder. */
function isOutcomeUnknown(op: CleanupOp): boolean {
  return op.status === 'FAILED' && op.submitAttemptedAt !== null && !op.bulkOperationId;
}

/** One sentence for the run naming each op that did not complete. Identical
 *  reasons are folded ("Deletes 1, 2, 3: …") so five ops refused for one cause do
 *  not repeat it five times inside the 500-char column. */
function rollUpError(ops: CleanupOp[], failed: CleanupOp[]): string {
  if (ops.length === 1) return failed[0].error ?? `Bulk delete ${failed[0].status}.`;
  const byReason = new Map<string, number[]>();
  for (const op of failed) {
    const reason = op.error ?? `Bulk delete ${op.status}.`;
    byReason.set(reason, [...(byReason.get(reason) ?? []), op.opIndex + 1]);
  }
  const parts = [...byReason].map(
    ([reason, nums]) => `${nums.length === 1 ? 'Delete' : 'Deletes'} ${nums.join(', ')}: ${reason}`,
  );
  return `${failed.length} of ${ops.length} deletes did not complete. ${parts.join(' ')}`;
}

/**
 * Once every op is terminal, finish the run: ONE guarded transition that sums the
 * ops' counts and refused ids. COMPLETED only if every op completed; otherwise
 * FAILED, keeping the counts of the ops that did finish — what was deleted was
 * deleted.
 *
 * Only the poll that makes the transition touches the lock, and only after the
 * terminal write has committed. It releases the store — unless an op failed with
 * its outcome unknown. Then the run gets submitAttemptedAt (it has no
 * bulkOperationId), which storeLock already reads as "FAILED while submitting, may
 * still be running", so the store stays busy until the lock's TTL instead of
 * landing the next colleague on a live delete. No lock code knows about ops.
 */
async function rollUpCleanupRun(runId: string): Promise<void> {
  const ops = await prisma.cleanupOp.findMany({
    where: { cleanupRunId: runId },
    orderBy: { opIndex: 'asc' },
  });
  if (ops.length === 0) return;
  if (ops.some((op) => !TERMINAL_BULK_STATUSES.includes(op.status))) return;

  const failed = ops.filter((op) => op.status !== 'COMPLETED');
  const ambiguous = ops.some(isOutcomeUnknown);
  const errors = ops.flatMap((op) => (op.errors ?? []) as unknown as BulkDeleteFailure[]);

  const { count } = await prisma.cleanupRun.updateMany({
    where: { id: runId, status: { notIn: TERMINAL_BULK_STATUSES } },
    data: {
      status: failed.length === 0 ? 'COMPLETED' : 'FAILED',
      deleted: ops.reduce((n, op) => n + op.deleted, 0),
      failedCount: ops.reduce((n, op) => n + op.failedCount, 0),
      errors: errors.length > 0 ? (errors as unknown as object[]) : undefined,
      error: failed.length === 0 ? null : rollUpError(ops, failed).slice(0, 500),
      ...(ambiguous ? { submitAttemptedAt: new Date() } : {}),
    },
  });
  if (count === 1 && !ambiguous) await releaseStoreLock(runId);
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
  // A run submitted as one op, before the split: reconciled exactly as before.
  if (run.bulkOperationId) return reconcileSingleOpRun(run);

  const ops = await prisma.cleanupOp.findMany({
    where: { cleanupRunId: id },
    orderBy: { opIndex: 'asc' },
  });
  // No ops means the run is still PENDING — the submit never happened, and
  // resume-on-boot owns that, not the poll.
  if (ops.length === 0) return run;

  // An op with no op id is PENDING (a crash mid-submit) — resume's, not ours.
  const open = ops.filter((op) => !TERMINAL_BULK_STATUSES.includes(op.status) && op.bulkOperationId);
  let failure: unknown = null;
  if (open.length > 0) {
    const adapter = adapterFor(run.entity as CleanupEntity);
    // Before any op's poll counter is touched — see reconcileSingleOpRun.
    const client = await getShopifyClient(run.storeId ?? undefined);
    const ids = (run.submittedIds ?? []) as string[];
    // Each op is advanced on its own: one op's bad poll must not stop the others.
    const results = await Promise.allSettled(
      open.map((op) => advanceCleanupOp(client, op, ids, adapter.deleteSpec)),
    );
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    failure = rejected ? rejected.reason : null;
    // Still being watched, so keep holding the store.
    if (results.some((r) => r.status === 'fulfilled' && r.value === 'running')) {
      await renewStoreLock(id);
    }
  }

  // Also when nothing was open: a roll-up an earlier caller lost to a DB error is
  // retried here.
  await rollUpCleanupRun(id);
  // A bad poll of one op is reported the way a single-op run's is, after the
  // others have been advanced.
  if (failure) throw failure;
  return prisma.cleanupRun.findUnique({ where: { id } });
}

/**
 * One poll step for one op: the per-op twin of reconcileSingleOpRun, same rules.
 * The op's terminal write is guarded on its status, so two concurrent polls cannot
 * both finish it. Returns whether Shopify still reports the op running.
 */
async function advanceCleanupOp(
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  op: CleanupOp,
  submittedIds: string[],
  spec: BulkDeleteSpec,
): Promise<'running' | 'done'> {
  // Atomic increment, as for a single-op run: concurrent polls must both count.
  const { pollAttempts: attempts } = await prisma.cleanupOp.update({
    where: { id: op.id },
    data: { pollAttempts: { increment: 1 } },
    select: { pollAttempts: true },
  });
  const overCap = attempts > MAX_JOB_POLL_ATTEMPTS;

  const finishOp = async (data: Prisma.CleanupOpUpdateManyMutationInput): Promise<'done'> => {
    await prisma.cleanupOp.updateMany({
      where: { id: op.id, status: { notIn: TERMINAL_BULK_STATUSES } },
      data,
    });
    return 'done';
  };

  let state: Awaited<ReturnType<typeof fetchBulkOperationState>>;
  try {
    state = await fetchBulkOperationState(client, op.bulkOperationId!);
  } catch (err) {
    // The cap only ends an op whose status cannot be READ — see reconcileSingleOpRun.
    if (!overCap) throw err;
    return finishOp({
      status: 'FAILED',
      error: `Could not read the bulk delete's status from Shopify after ${MAX_JOB_POLL_ATTEMPTS} checks (${(err as Error).message}). Check the store, and re-run cleanup if tagged records remain.`.slice(0, 500),
    });
  }

  if (!TERMINAL_BULK_STATUSES.includes(state.status)) {
    // Shopify says it is still deleting: past the cap or not, it stays RUNNING.
    if (overCap) {
      console.warn(
        `[cleanup] op ${op.id}: still ${state.status} at Shopify after ${attempts} status checks; keeping the store locked`,
      );
    }
    return 'running';
  }

  if (state.status !== 'COMPLETED') {
    return finishOp({
      status: state.status,
      error: `Bulk delete ${state.status}${state.errorCode ? ` (${state.errorCode})` : ''}.`,
    });
  }

  if (!state.url) return finishOp({ status: 'COMPLETED', deleted: 0, failedCount: 0 });

  // The result file maps back BY LINE to exactly the ids this op was given, so its
  // slice is recomputed from the persisted list — never the whole list.
  const slice = splitIntoBatches(submittedIds, op.opCount)[op.opIndex] ?? [];
  const { deleted, errors } = await parseBulkDeleteResults(state.url, slice, spec);
  return finishOp({
    status: 'COMPLETED',
    deleted,
    failedCount: errors.length,
    errors: errors.length > 0 ? (errors as unknown as object[]) : undefined,
  });
}

/** reconcileCleanupRun for a run submitted as ONE bulk op (bulkOperationId on the
 *  run itself) — every run before the split into cleanup_ops. Unchanged. */
async function reconcileSingleOpRun(run: CleanupRun): Promise<CleanupRun | null> {
  const id = run.id;
  const adapter = adapterFor(run.entity as CleanupEntity);

  // Build the client BEFORE touching the poll counter. Eleven instances share one
  // database and each holds tokens for its own stores only; on an instance that does
  // not own this store getShopifyClient throws "not configured". When the counter was
  // bumped first, every non-owner's attempt burned the cap, and the run was failed —
  // and its store released — while Shopify was still deleting.
  const client = await getShopifyClient(run.storeId ?? undefined);

  // Atomic increment: two concurrent polls (a browser and the sweep) must both count,
  // not both write the same read-modify-write value.
  const { pollAttempts: attempts } = await prisma.cleanupRun.update({
    where: { id },
    data: { pollAttempts: { increment: 1 } },
    select: { pollAttempts: true },
  });
  const overCap = attempts > MAX_JOB_POLL_ATTEMPTS;

  const finish = async (data: Prisma.CleanupRunUpdateManyMutationInput) => {
    // Guarded on status: a slower concurrent poll must not overwrite a terminal
    // result (COMPLETED with FAILED, or the other way round). Only the poll that
    // actually made the transition releases the store.
    const { count } = await prisma.cleanupRun.updateMany({
      where: { id, status: { notIn: TERMINAL_BULK_STATUSES } },
      data,
    });
    if (count === 1) await releaseStoreLock(id);
    return prisma.cleanupRun.findUnique({ where: { id } });
  };

  let state: Awaited<ReturnType<typeof fetchBulkOperationState>>;
  try {
    state = await fetchBulkOperationState(client, run.bulkOperationId!);
  } catch (err) {
    // Under the cap, a failed status read is just a bad poll: the next one retries.
    if (!overCap) throw err;
    // Over it, we have been unable to see this operation for the whole budget. We
    // cannot say it is still running, and an unreadable run must not sit RUNNING
    // forever, so it ends — telling the user what to check.
    return finish({
      status: 'FAILED',
      error: `Could not read the bulk delete's status from Shopify after ${MAX_JOB_POLL_ATTEMPTS} checks (${(err as Error).message}). Check the store, and re-run cleanup if tagged records remain.`.slice(0, 500),
    });
  }

  // Still deleting — leave it RUNNING and let the next poll look again.
  if (!TERMINAL_BULK_STATUSES.includes(state.status)) {
    // Past the poll budget, but Shopify itself says the delete is still running, so
    // the honest state is still RUNNING: failing the run here would release the store
    // under a live delete. The cap bounds runs we cannot SEE, not slow ones.
    if (overCap) {
      console.warn(
        `[cleanup] ${id}: still ${state.status} at Shopify after ${attempts} status checks; keeping the store locked`,
      );
    }
    // Still being watched, so keep holding the store.
    await renewStoreLock(id);
    return prisma.cleanupRun.findUnique({ where: { id } });
  }

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

/**
 * Advance every still-running cleanup, independent of any browser.
 *
 * The bulk path holds its store lock until reconcileCleanupRun brings the run to
 * terminal — and that only ever runs when a client polls GET /api/cleanup/:id. A
 * cleanup whose watcher walked away (closed the tab, or a bulk delete that outran
 * the client's ~5-min poll cap) then sits RUNNING with Shopify already finished,
 * holding its store "busy" until the 30-min lock TTL finally expires. The store is
 * falsely unavailable for up to half an hour after the delete actually completed.
 *
 * This is the server-side backstop: a periodic sweep reconciles those orphaned runs
 * itself, so the lock is handed back within one sweep of Shopify finishing rather
 * than at the TTL ceiling. reconcileCleanupRun is idempotent and guards on status,
 * so racing a live client poll on the same run is harmless.
 *
 * Only bulk-path rows are touched: a run with ops, or a pre-split run with its
 * bulkOperationId set. A PENDING row has neither yet and belongs to resume-on-boot,
 * not here — the reconcile guard would bounce it anyway.
 *
 * Only rows for stores THIS instance holds credentials for — see sweepOwnsStore.
 * The import sweep always did this; this one did not, so one colleague's cleanup
 * filled every other instance's log with "store is not configured" once a minute.
 *
 * Serves the customer and product flows alike — one engine, both flows.
 */
export async function sweepRunningCleanups(): Promise<void> {
  const stuck = await prisma.cleanupRun.findMany({
    where: {
      status: { notIn: TERMINAL_BULK_STATUSES },
      OR: [{ bulkOperationId: { not: null } }, { ops: { some: {} } }],
    },
    select: { id: true, storeId: true },
  });

  for (const { id, storeId } of stuck) {
    if (!sweepOwnsStore(storeId)) continue;
    // One unreachable store must not stop the rest from being reconciled.
    try {
      await reconcileCleanupRun(id);
    } catch (err) {
      console.error(`[cleanup-sweep] failed to reconcile ${id}:`, (err as Error).message);
    }
  }
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

/**
 * Re-submit a cleanup that never got as far as its ops — the process died before
 * the transaction that writes them. Its ops are created and submitted exactly as
 * the live path does (launchCleanupOps).
 */
async function relaunchCleanupRun(id: string): Promise<void> {
  const run = await prisma.cleanupRun.findUnique({ where: { id } });
  if (!run) return;

  const adapter = adapterFor(run.entity as CleanupEntity);

  // NULL submittedIds means the process died BEFORE the tagged records were listed
  // (mid-fetchIdsByTag) — "never listed", which is not "listed, and there were
  // none". Reading it as an empty list marked the run COMPLETED with 0 deleted while
  // every tagged record was still in the store. List them now, by the run's tag,
  // exactly as the live path does; this resume already holds the store's lock.
  let ids: string[];
  let listed: Prisma.CleanupRunUpdateManyMutationInput = {};
  if (run.submittedIds === null) {
    const fetched = await adapter.fetchIdsByTag(run.storeId ?? undefined, run.tag);
    ids = fetched.ids;
    listed = { shopDomain: fetched.shop, found: ids.length };
  } else {
    ids = run.submittedIds as string[];
  }

  if (ids.length === 0) {
    await prisma.cleanupRun.updateMany({
      where: { id, status: 'PENDING' },
      data: { ...listed, submittedIds: ids, status: 'COMPLETED', deleted: 0, failedCount: 0 },
    });
    // Done before it started — the store is free.
    await releaseStoreLock(id);
    return;
  }

  const client = await getShopifyClient(run.storeId ?? undefined);
  await launchCleanupOps(id, client, ids, adapter, listed);
}

/** Re-submit one op that provably never reached Shopify, then roll its run up. */
async function relaunchCleanupOp(opId: string): Promise<void> {
  const op = await prisma.cleanupOp.findUnique({
    where: { id: opId },
    include: { cleanupRun: true },
  });
  if (!op || op.status !== 'PENDING') return;
  const run = op.cleanupRun;
  const adapter = adapterFor(run.entity as CleanupEntity);
  // The same slice the live launch gave this op, recomputed from the persisted ids.
  const slice = splitIntoBatches((run.submittedIds ?? []) as string[], op.opCount)[op.opIndex] ?? [];
  const client = await getShopifyClient(run.storeId ?? undefined);
  await launchCleanupOp(op.id, client, slice, adapter.deleteSpec);
  await rollUpCleanupRun(run.id);
}

/** Fail an op resume could not relaunch, then roll its run up — this may have been
 *  the last op the run was waiting on. */
async function failCleanupOp(opId: string, error: string): Promise<void> {
  await failRow(prisma.cleanupOp as never, opId, error);
  const op = await prisma.cleanupOp.findUnique({
    where: { id: opId },
    select: { cleanupRunId: true },
  });
  if (op) await rollUpCleanupRun(op.cleanupRunId);
}

/**
 * A cleanup interrupted between "row written" and "delete submitted" is resumed
 * like any other PENDING row: re-submitted if it provably never called Shopify,
 * failed if the submit's outcome is unknown. Deleting twice would be harmless here,
 * but the shop cannot tell us which bulk op is ours, so resume cannot recover the
 * real deleted/failed counts either — a FAILED run that says "check and re-run" is
 * honest, where a guessed op could report another operation's counts.
 *
 * Two tables, two stores. A PENDING run died before its ops were written (it is
 * relaunched whole). A PENDING op died between the ops being written and its own
 * submit being recorded; it has no store or lock of its own, so it reads its run's
 * store and re-takes its run's lock (re-entrant for the same owner). An op failed
 * as outcome-unknown leaves submitAttemptedAt set, so the roll-up keeps the store
 * busy until the TTL, exactly like the live ambiguous submit.
 */
export function cleanupResumableStores(): ResumableStore[] {
  return [
    {
      label: 'cleanup',
      findResumable: (staleBefore) => findResumableRows(prisma.cleanupRun as never, staleBefore),
      claim: (id, staleBefore) => claimRow(prisma.cleanupRun as never, id, staleBefore),
      relaunch: relaunchCleanupRun,
      fail: (id, error) => failRow(prisma.cleanupRun as never, id, error),
      lockOwner: (row) => ({
        ownerType: 'CLEANUP_RUN',
        ownerId: row.id,
        operation: 'a cleanup',
      }),
    },
    {
      label: 'cleanup-op',
      findResumable: async (staleBefore) => {
        const ops = await prisma.cleanupOp.findMany({
          where: {
            status: 'PENDING',
            OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
          },
          select: {
            id: true,
            createdAt: true,
            submitAttemptedAt: true,
            cleanupRunId: true,
            cleanupRun: { select: { storeId: true } },
          },
        });
        return ops.map((op) => ({
          id: op.id,
          storeId: op.cleanupRun.storeId,
          createdAt: op.createdAt,
          submitAttemptedAt: op.submitAttemptedAt,
          cleanupRunId: op.cleanupRunId,
        }));
      },
      claim: (id, staleBefore) => claimRow(prisma.cleanupOp as never, id, staleBefore),
      relaunch: relaunchCleanupOp,
      fail: failCleanupOp,
      lockOwner: (row) => ({
        ownerType: 'CLEANUP_RUN',
        ownerId: row.cleanupRunId!,
        operation: 'a cleanup',
      }),
    },
  ];
}

/**
 * What the cleanup endpoints send back. Every field client/src/api/cleanupPoller.ts
 * reads, and nothing it does not: submittedIds can be 80k ids, and the client
 * re-fetches the run every 2s while it runs. Op ids, poll counters and claim
 * timestamps are the server's business.
 */
export type CleanupRunView = Pick<
  CleanupRun,
  | 'id'
  | 'entity'
  | 'storeId'
  | 'shopDomain'
  | 'tag'
  | 'importRunId'
  | 'status'
  | 'found'
  | 'deleted'
  | 'failedCount'
  | 'error'
  | 'errors'
  | 'createdAt'
  | 'updatedAt'
>;

export function toCleanupRunView(run: CleanupRun): CleanupRunView {
  return {
    id: run.id,
    entity: run.entity,
    storeId: run.storeId,
    shopDomain: run.shopDomain,
    tag: run.tag,
    importRunId: run.importRunId,
    status: run.status,
    found: run.found,
    deleted: run.deleted,
    failedCount: run.failedCount,
    error: run.error,
    errors: run.errors,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
