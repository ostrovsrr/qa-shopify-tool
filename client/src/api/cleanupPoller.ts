import axios from 'axios';

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup is asynchronous on the server now.
//
// It used to run entirely inside the POST: Shopify was polled for up to 300
// seconds while the request hung. That is fine on localhost and impossible hosted
// — a platform proxy gives up around 100s, so the request dies mid-delete and the
// user is told nothing at all.
//
// The POST now returns 202 with one CleanupRun per store, and the run is advanced
// one step per GET. This module does that polling and folds the runs back into the
// single result shape the UI already renders, so no component had to change.
//
// Shared by the customer and product flows — they are twins.
// ─────────────────────────────────────────────────────────────────────────────

const api = axios.create({ baseURL: '/api' });

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'];

const POLL_INTERVAL_MS = 2000;
// ~5 minutes. The server independently bounds a stuck operation, so this is only
// the client giving up on watching, not the cleanup itself being abandoned.
const MAX_POLLS = 150;

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

/** The aggregate the UI renders: totals across every store the cleanup touched. */
export interface CleanupSummary {
  storeId?: string;
  shop: string;
  tag: string;
  found: number;
  deleted: number;
  failed: number;
  errors: { id: string; message: string }[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pollUntilTerminal(run: CleanupRun): Promise<CleanupRun> {
  let current = run;
  for (let i = 0; i < MAX_POLLS && !TERMINAL.includes(current.status); i++) {
    await sleep(POLL_INTERVAL_MS);
    const { data } = await api.get<CleanupRun>(`/cleanup/${current.id}`);
    current = data;
  }
  return current;
}

/**
 * Watch every cleanup run to completion and fold them into one summary.
 *
 * A run that comes back already COMPLETED (a small teardown the server did inline)
 * is not polled at all — it just contributes its counts.
 */
export async function awaitCleanupRuns(runs: CleanupRun[]): Promise<CleanupSummary> {
  const finished = await Promise.all(runs.map(pollUntilTerminal));

  const failedRuns = finished.filter((r) => r.status !== 'COMPLETED');
  if (failedRuns.length > 0 && failedRuns.length === finished.length) {
    // Every store failed — surface Shopify's reason rather than reporting "0 deleted".
    throw new Error(failedRuns[0].error ?? 'Cleanup failed.');
  }

  return {
    storeId: finished.length === 1 ? (finished[0].storeId ?? undefined) : undefined,
    shop: [...new Set(finished.map((r) => r.shopDomain))].join(', '),
    tag: finished[0]?.tag ?? '',
    found: finished.reduce((n, r) => n + r.found, 0),
    deleted: finished.reduce((n, r) => n + r.deleted, 0),
    failed: finished.reduce((n, r) => n + r.failedCount, 0),
    errors: finished.flatMap((r) => r.errors ?? []),
  };
}
