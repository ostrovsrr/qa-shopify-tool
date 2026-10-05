import { createApiClient, isTransientError } from './http';
import type { CleanupStoreOutcome } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup is asynchronous on the server now.
//
// It used to run entirely inside the POST: Shopify was polled for up to 300
// seconds while the request hung. That is fine on localhost and impossible hosted
// — a platform proxy gives up around 100s, so the request dies mid-delete and the
// user is told nothing at all.
//
// The POST now returns 202 with one CleanupRun per store, and the run is advanced
// one step per GET. This module does that polling and folds the runs back into
// one result — totals for the headline, plus how EACH store ended, so a partial
// failure is never reported as "Deleted N … (s1, s2, s3)" with s3 untouched.
//
// Shared by the customer and product flows — they are twins.
// ─────────────────────────────────────────────────────────────────────────────

// Same client as validationApi/productApi: actor header + server error sentence.
const api = createApiClient();

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'];

const POLL_INTERVAL_MS = 2000;
// ~5 minutes. The server independently bounds a stuck operation, so this is only
// the client giving up on watching, not the cleanup itself being abandoned.
const MAX_POLLS = 150;
// A GET that fails transiently (a 502, a restart) is retried; this many in a row
// and the client stops watching that store — the server keeps deleting.
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

export interface CleanupRun {
  id: string;
  entity: 'CUSTOMER' | 'PRODUCT';
  storeId: string | null;
  shopDomain: string;
  tag: string;
  status: string;
  found: number;
  deleted: number;
  failedCount: number;
  error: string | null;
  errors: { id: string; message: string }[] | null;
}

/** The aggregate the UI renders: totals across every store, plus each store. */
export interface CleanupSummary {
  storeId?: string;
  shop: string;
  tag: string;
  found: number;
  deleted: number;
  failed: number;
  errors: { id: string; message: string }[];
  stores: CleanupStoreOutcome[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Watched {
  run: CleanupRun;
  outcome: CleanupStoreOutcome;
}

function outcomeOf(run: CleanupRun, status: CleanupStoreOutcome['status'], error: string | null): Watched {
  return {
    run,
    outcome: {
      storeId: run.storeId,
      shop: run.shopDomain,
      status,
      found: run.found,
      deleted: run.deleted,
      error,
    },
  };
}

/** Never rejects: whatever happens to one store is that store's outcome, so one
 *  store's hiccup cannot hide what happened on the others. */
async function watchRun(run: CleanupRun): Promise<Watched> {
  let current = run;
  let consecutiveErrors = 0;
  for (let i = 0; i < MAX_POLLS && !TERMINAL.includes(current.status); i++) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const { data } = await api.get<CleanupRun>(`/cleanup/${current.id}`);
      current = data;
      consecutiveErrors = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lost contact with the server.';
      if (!isTransientError(err)) return outcomeOf(current, 'failed', message);
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        // We cannot see it, but nothing says it stopped: the server advances the
        // run on its own schedule. Say "still running", not "failed".
        return outcomeOf(current, 'running', message);
      }
    }
  }
  if (current.status === 'COMPLETED') return outcomeOf(current, 'completed', null);
  if (TERMINAL.includes(current.status)) {
    return outcomeOf(current, 'failed', current.error ?? `Cleanup ${current.status.toLowerCase()}.`);
  }
  // Out of polls while the server is still deleting. Not a failure.
  return outcomeOf(current, 'running', null);
}

/**
 * Watch every cleanup run to completion and fold them into one summary.
 *
 * A run that comes back already COMPLETED (a small teardown the server did inline)
 * is not polled at all — it just contributes its counts. Throws only when EVERY
 * store failed, with each store's reason; a partial failure comes back in
 * `stores` for the caller to report per store (see describeCleanup).
 */
export async function awaitCleanupRuns(runs: CleanupRun[]): Promise<CleanupSummary> {
  const watched = await Promise.all(runs.map(watchRun));
  const finished = watched.map((w) => w.run);
  const stores = watched.map((w) => w.outcome);

  if (stores.length > 0 && stores.every((s) => s.status === 'failed')) {
    throw new Error(
      stores.length === 1
        ? stores[0].error ?? 'Cleanup failed.'
        : stores.map((s) => `${s.shop}: ${s.error ?? 'cleanup failed.'}`).join(' | '),
    );
  }

  return {
    storeId: finished.length === 1 ? (finished[0].storeId ?? undefined) : undefined,
    shop: [...new Set(finished.map((r) => r.shopDomain))].join(', '),
    tag: finished[0]?.tag ?? '',
    found: finished.reduce((n, r) => n + r.found, 0),
    deleted: finished.reduce((n, r) => n + r.deleted, 0),
    failed: finished.reduce((n, r) => n + r.failedCount, 0),
    errors: finished.flatMap((r) => r.errors ?? []),
    stores,
  };
}

/**
 * Turn per-store outcomes into the panel's notice (what was cleaned, what is
 * still deleting) and error (which store failed, in the server's own words).
 * `noun` is "customer" or "product"; `label` maps a store to its display name.
 * Shared by both flows so their wording cannot drift apart.
 */
export function describeCleanup(
  stores: CleanupStoreOutcome[],
  noun: string,
  label: (storeId: string | null, shop: string) => string = (_id, shop) => shop,
): { notice: string; error: string } {
  const name = (s: CleanupStoreOutcome) => label(s.storeId, s.shop);
  const done = stores.filter((s) => s.status === 'completed');
  const running = stores.filter((s) => s.status === 'running');
  const failed = stores.filter((s) => s.status === 'failed');

  const notice: string[] = [];
  if (done.length > 0) {
    const deleted = done.reduce((n, s) => n + s.deleted, 0);
    const found = done.reduce((n, s) => n + s.found, 0);
    notice.push(
      `Deleted ${deleted} of ${found} qa-import ${noun}(s) from ${done.map(name).join(', ')}.`,
    );
  }
  if (running.length > 0) {
    notice.push(
      `Still deleting in the background on ${running.map(name).join(', ')} ` +
        `(${running.reduce((n, s) => n + s.deleted, 0)} deleted so far) — ` +
        'check the store count again in a few minutes.',
    );
  }
  const error = failed
    .map((s) => `Cleanup failed on ${name(s)}: ${s.error ?? 'unknown error.'}`)
    .join(' | ');
  return { notice: notice.join(' '), error };
}
