import prisma from '../db/prisma';
import { getShopifyClient } from './shopifyClient';
import { CurrentBulkOperation, fetchCurrentBulkOperation } from './shopifyBulk';

// ─────────────────────────────────────────────────────────────────────────────
// CRASH RECOVERY for interrupted imports. Shared by the customer and product
// flows, which are twins.
//
// Pre-persisting rows as PENDING before submitting a bulk op stopped the tool
// from LYING (a partial fan-out can no longer roll up to COMPLETED). But on its
// own it traded a wrong answer for a permanent hang: a row that never got its op
// submitted sits PENDING forever, and the run never finishes.
//
// This is what finishes them. On boot, every PENDING row is resolved exactly once.
// ─────────────────────────────────────────────────────────────────────────────

/** A claim older than this is assumed dead (the process holding it was killed) and
 *  may be taken over. Without reclaiming, a mid-claim OOM strands the row forever —
 *  which is just a different way of never telling the truth. */
export const STALE_CLAIM_MS = 10 * 60 * 1000; // 10 minutes

/** What to do with one interrupted row. */
export type ResumeDecision =
  | { action: 'adopt'; bulkOperationId: string; opStatus: string }
  | { action: 'relaunch' };

/**
 * THE DECISION. Pure, so it can be tested exhaustively without a store.
 *
 * Shopify allows exactly ONE bulk mutation per shop. So when we find a PENDING row
 * — meaning "the row was written, but we have no operation id for it" — there are
 * exactly two possibilities:
 *
 *   1. We submitted an op and died before persisting its id. That op is then the
 *      shop's CURRENT operation, and Shopify created it AFTER our row was written.
 *      → ADOPT it. Re-submitting instead would either bounce off the per-shop limit
 *        or, if the first op had finished, DUPLICATE a merchant's entire import.
 *        Adopting also recovers the results: the normal reconcile will fetch the
 *        op's result file and finalize the run as if nothing had happened.
 *
 *   2. We died before submitting anything. Then the shop either has no operation at
 *      all, or has an older one from some earlier run — either way nothing on the
 *      shop postdates our row.
 *      → RELAUNCH. Provably safe: no records were created for this row.
 *
 * The createdAt comparison is the whole idempotency key. Get it backwards and you
 * either duplicate an import or silently drop one.
 */
export function decideResume(
  rowCreatedAt: Date,
  current: CurrentBulkOperation | null,
): ResumeDecision {
  if (!current) return { action: 'relaunch' };

  const opCreatedAt = new Date(current.createdAt);
  // Strictly-after would race a same-millisecond submit; >= is the safe side,
  // because a false ADOPT merely re-reads an op we own, while a false RELAUNCH
  // duplicates real records in a real store.
  if (opCreatedAt.getTime() >= rowCreatedAt.getTime()) {
    return { action: 'adopt', bulkOperationId: current.id, opStatus: current.status };
  }

  return { action: 'relaunch' };
}

/** One interrupted row, whichever table it came from. */
export interface ResumableRow {
  id: string;
  storeId: string | null;
  createdAt: Date;
}

/**
 * The four tables that can hold a PENDING row (customer run/job, product run/job)
 * behave identically here, so each supplies this and the algorithm below is written
 * once. Implementations live next to the flow they belong to.
 */
export interface ResumableStore {
  /** Human label, for logs. */
  label: string;
  /** PENDING rows that are unclaimed, or whose claim has gone stale. */
  findResumable(staleBefore: Date): Promise<ResumableRow[]>;
  /** Atomically take ownership. False if another process got there first. */
  claim(id: string, staleBefore: Date): Promise<boolean>;
  /** Attach the bulk op we found on the shop and let the normal reconcile finish it. */
  adopt(id: string, bulkOperationId: string): Promise<void>;
  /** Re-run the submit for a row whose op never reached Shopify. */
  relaunch(id: string): Promise<void>;
  /** Give up on this row, with a reason the user can act on. */
  fail(id: string, error: string): Promise<void>;
}

export interface ResumeSummary {
  adopted: number;
  relaunched: number;
  failed: number;
  skipped: number;
}

/** Resolve every interrupted row in one store. */
export async function resumeStore(store: ResumableStore): Promise<ResumeSummary> {
  const summary: ResumeSummary = { adopted: 0, relaunched: 0, failed: 0, skipped: 0 };
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

  const rows = await store.findResumable(staleBefore);

  for (const row of rows) {
    // Claim first. Two overlapping boots (a rolling deploy) must not both work
    // the same row — that is how you get two bulk ops submitted for one job.
    const claimed = await store.claim(row.id, staleBefore);
    if (!claimed) {
      summary.skipped++;
      continue;
    }

    try {
      const client = await getShopifyClient(row.storeId ?? undefined);
      const current = await fetchCurrentBulkOperation(client);
      const decision = decideResume(row.createdAt, current);

      if (decision.action === 'adopt') {
        await store.adopt(row.id, decision.bulkOperationId);
        summary.adopted++;
        console.log(
          `[resume] ${store.label} ${row.id}: adopted in-flight bulk op ` +
            `${decision.bulkOperationId} (${decision.opStatus}) — results will be reconciled`,
        );
      } else {
        await store.relaunch(row.id);
        summary.relaunched++;
        console.log(`[resume] ${store.label} ${row.id}: never submitted, relaunched`);
      }
    } catch (err) {
      const message = (err as Error).message;
      await store.fail(row.id, `Interrupted and could not be resumed: ${message}`);
      summary.failed++;
      console.error(`[resume] ${store.label} ${row.id}: FAILED — ${message}`);
    }
  }

  return summary;
}

/**
 * Resolve every interrupted import across both flows. Called once on boot.
 *
 * Registered lazily (dynamic import) so this module stays free of import cycles:
 * the import services already depend on shopifyBulk and shopifyClient, and pulling
 * them in at module scope here would knot the graph.
 */
export async function resumePendingImports(): Promise<ResumeSummary> {
  const total: ResumeSummary = { adopted: 0, relaunched: 0, failed: 0, skipped: 0 };

  const [{ customerResumableStores }, { productResumableStores }] = await Promise.all([
    import('./shopifyImport.service'),
    import('./productImport.service'),
  ]);

  const stores = [...customerResumableStores(), ...productResumableStores()];

  for (const store of stores) {
    const s = await resumeStore(store);
    total.adopted += s.adopted;
    total.relaunched += s.relaunched;
    total.failed += s.failed;
    total.skipped += s.skipped;
  }

  const touched = total.adopted + total.relaunched + total.failed;
  if (touched > 0) {
    console.log(
      `[resume] recovered ${touched} interrupted import row(s): ` +
        `${total.adopted} adopted, ${total.relaunched} relaunched, ${total.failed} failed`,
    );
  }
  return total;
}

// ── shared prisma plumbing ───────────────────────────────────────────────────
//
// The four delegates have identical shapes for the fields resume touches, but
// Prisma gives each a distinct type, so this narrow structural interface is what
// lets one implementation serve all four rather than four near-copies.

export interface ResumeDelegate {
  findMany(args: unknown): Promise<{ id: string; storeId: string | null; createdAt: Date }[]>;
  updateMany(args: unknown): Promise<{ count: number }>;
}

/** PENDING rows that nobody is working (or whose worker died). */
export async function findResumableRows(
  delegate: ResumeDelegate,
  staleBefore: Date,
): Promise<ResumableRow[]> {
  return delegate.findMany({
    where: {
      status: 'PENDING',
      OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
    },
    select: { id: true, storeId: true, createdAt: true },
  });
}

/**
 * Take ownership, atomically. The WHERE re-checks status and the claim window, so
 * two processes racing on the same row cannot both win: exactly one updateMany
 * matches, the other sees count 0.
 */
export async function claimRow(
  delegate: ResumeDelegate,
  id: string,
  staleBefore: Date,
): Promise<boolean> {
  const { count } = await delegate.updateMany({
    where: {
      id,
      status: 'PENDING',
      OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
    },
    data: { claimedAt: new Date() },
  });
  return count === 1;
}

/** Attach the recovered bulk op; the normal reconcile takes it from here. */
export async function adoptRow(
  delegate: ResumeDelegate,
  id: string,
  bulkOperationId: string,
): Promise<void> {
  await delegate.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'RUNNING', bulkOperationId },
  });
}

export async function failRow(
  delegate: ResumeDelegate,
  id: string,
  error: string,
): Promise<void> {
  await delegate.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'FAILED', error: error.slice(0, 500) },
  });
}

export { prisma };
