import { getShopifyStoresConfig, resolveStoreId } from '../config/shopify';
import {
  BulkOperationNotFoundError,
  BulkOperationState,
  BulkResultParseError,
  fetchBulkOperationState,
  MAX_IMPORT_RUNTIME_MS,
  TERMINAL_BULK_STATUSES,
} from './shopifyBulk';
import {
  getShopifyClient,
  ShopifyAuthError,
  ShopifyConfigError,
  ShopifyOutcomeUnknownError,
} from './shopifyClient';

// ─────────────────────────────────────────────────────────────────────────────
// ADVANCE ONE IMPORT OPERATION BY ONE STEP.
//
// The customer and product flows are twins, and each has two shapes of the same
// thing — a single-store run and a batch job — so there are four places that poll
// a bulk op and act on the answer. They used to be four copies, and they drifted:
// the batch copies isolated errors and bounded a stuck job; the single-run copies
// did neither, so one Shopify hiccup threw out of the poll and a run whose op had
// vanished stayed RUNNING forever. This is the one copy. Each caller supplies
// only what differs — which table, which rows.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does THIS instance hold credentials for this store?
 *
 * One instance per Solution Engineer runs against a SHARED database, so every
 * instance sees every colleague's runs — in the background sweep, and in History,
 * where reopening a colleague's run polls it. An instance that cannot build a
 * client for a store must leave that store's runs alone: failing them for want of
 * a token they were never meant to have would kill a colleague's healthy import
 * while their own instance is still driving it.
 *
 * Judged only when there IS a config to judge against: with no usable store list,
 * resolveStoreId returns null for everything alike, and skipping on that basis
 * would turn a misconfiguration into a silent no-op. Same reasoning as
 * importResume.service.ts.
 */
export function instanceOwnsStore(storeId: string | null): boolean {
  const config = getShopifyStoresConfig();
  const canJudge = config.ok && config.stores.length > 0;
  if (!canJudge) return true;
  if (!storeId) return true; // legacy single-store row — let the normal path speak
  return Boolean(resolveStoreId(storeId));
}

/** The error recorded on a run whose op ended without completing. */
export function endedOpError(state: Pick<BulkOperationState, 'status' | 'errorCode'>): string {
  return `Bulk operation ${state.status}${state.errorCode ? ` (${state.errorCode})` : ''}.`;
}

/** Told to the user when a submit's outcome is unknown. They are the only one who
 *  can look at the store, so say what to look for. */
export const AMBIGUOUS_SUBMIT_MESSAGE =
  'Shopify did not confirm the import was submitted (the connection failed or a gateway ' +
  'error came back), so it may or may not be running. The store stays reserved for this ' +
  'run until that is settled. Check the store for its qa-import records and run QA ' +
  'cleanup if any are there before re-running.';

/** Is this a submit failure whose outcome we cannot know? */
export function isAmbiguousSubmitError(err: unknown): boolean {
  return err instanceof ShopifyOutcomeUnknownError;
}

export type ReconcileVerdict = { fail: true; error: string } | { fail: false };

/**
 * What to do with an error raised while polling or finalizing an operation.
 *
 * Permanent failures — the token is rejected, the shop domain is wrong, the op no
 * longer exists, the result file cannot be read — fail now: polling again gives
 * the same answer forever, and until the run is terminal it holds its store.
 *
 * Anything else is presumed transient and retried on the next poll, but only
 * within MAX_IMPORT_RUNTIME_MS of the submit. Past that, an op we have not been
 * able to read the state of for that long is given up on, with the warning that
 * it may still have run.
 */
export function classifyReconcileError(
  err: unknown,
  startedAt: Date,
  now: number = Date.now(),
): ReconcileVerdict {
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof ShopifyAuthError || err instanceof ShopifyConfigError) {
    return { fail: true, error: message };
  }
  if (err instanceof BulkOperationNotFoundError) {
    return {
      fail: true,
      error: `${message} Shopify no longer has this operation, so its results cannot be read.`,
    };
  }
  if (err instanceof BulkResultParseError) {
    return {
      fail: true,
      error: `Shopify finished the operation, but its result file could not be read: ${message}`,
    };
  }
  if (now - startedAt.getTime() > MAX_IMPORT_RUNTIME_MS) {
    const hours = Math.round(MAX_IMPORT_RUNTIME_MS / 3_600_000);
    return {
      fail: true,
      error:
        `Timed out: could not get this import's result from Shopify within ${hours}h of submitting it ` +
        `(last error: ${message}). It may still have run — check the store for its qa-import records.`,
    };
  }
  return { fail: false };
}

/** The one operation being advanced, and how to act on each outcome. */
export interface ImportOp {
  /** For log lines. */
  label: string;
  storeId: string | null;
  bulkOperationId: string;
  /** When the op was submitted — the stuck bound counts from here. */
  startedAt: Date;
  /** Op COMPLETED: download and record the results (guarded against double-write). */
  onCompleted(state: BulkOperationState): Promise<void>;
  /** Op ended FAILED / CANCELED / EXPIRED: record that, with any partial results. */
  onEnded(state: BulkOperationState, error: string): Promise<void>;
  /** Give up on the op: mark it FAILED with this reason. */
  onFailed(error: string): Promise<void>;
  renewLock(): Promise<void>;
  releaseLock(): Promise<void>;
}

/**
 * - `not-owned` — this instance has no credentials for the store; nothing touched.
 * - `running`   — Shopify still reports it non-terminal; its lock was renewed.
 * - `terminal`  — the op is now recorded as terminal and its store released.
 * - `retry`     — a transient error; left as is for the next poll.
 */
export type AdvanceResult = 'not-owned' | 'running' | 'terminal' | 'retry';

/**
 * Poll one op once and act on the answer. Never throws for a Shopify or result
 * error: one store erroring must not abort the caller's other work, and a throw
 * out of the GET poll used to leave a run RUNNING with its store held.
 *
 * Note what it does NOT do: fail an op Shopify still reports as RUNNING, however
 * long it has been running. Shopify bounds its own operations; we bound only the
 * time we have been unable to learn their state.
 */
export async function advanceImportOp(op: ImportOp, now: number = Date.now()): Promise<AdvanceResult> {
  // Whose op is it? Asked BEFORE building a client, because a client we cannot
  // build is not a failure of the op — it is a colleague's store. Marking their
  // run FAILED from here is exactly what a shared database must never allow.
  if (!instanceOwnsStore(op.storeId)) return 'not-owned';

  const fail = async (error: string): Promise<'terminal'> => {
    await op.onFailed(error);
    await op.releaseLock();
    return 'terminal';
  };

  // A row with no store can never be polled by anyone — there is no client to
  // build. Say so instead of leaving it RUNNING forever.
  if (!op.storeId) {
    return fail('This import has no store recorded, so its result cannot be read from Shopify.');
  }

  let client: Awaited<ReturnType<typeof getShopifyClient>>;
  try {
    client = await getShopifyClient(op.storeId);
  } catch (err) {
    // No client for this store here. Even when ownership could not be judged above
    // (no usable store list at all), that is THIS instance's configuration speaking,
    // not a fault of the op — never fail someone's import over it. Log it loudly
    // instead; the instance that owns the store will finish the run.
    if (err instanceof ShopifyConfigError) {
      console.error(`[import-reconcile] ${op.label}: no credentials here for store ${op.storeId}:`, err.message);
      return 'not-owned';
    }
    throw err;
  }

  try {
    const state = await fetchBulkOperationState(client, op.bulkOperationId);

    if (!TERMINAL_BULK_STATUSES.includes(state.status)) {
      // Someone is demonstrably still watching this op, so push the lock's expiry
      // out. The TTL only exists to free a store nobody is finishing; it must never
      // pull the store out from under an operation that is plainly still alive.
      await op.renewLock();
      return 'running';
    }

    if (state.status === 'COMPLETED') {
      await op.onCompleted(state);
    } else {
      await op.onEnded(state, endedOpError(state));
    }
    // Terminal either way — the store is free.
    await op.releaseLock();
    return 'terminal';
  } catch (err) {
    const verdict = classifyReconcileError(err, op.startedAt, now);
    if (verdict.fail) return fail(verdict.error.slice(0, 1000));
    console.warn(`[import-reconcile] ${op.label}: transient error, will retry:`, (err as Error).message);
    return 'retry';
  }
}
