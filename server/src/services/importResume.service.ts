import prisma from '../db/prisma';
import { getShopifyStoresConfig, resolveStoreId } from '../config/shopify';
import { acquireStoreLock, StoreLockOwner } from './storeLock.service';

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
  | { action: 'relaunch' }
  | { action: 'fail'; reason: string };

/** Why a row whose submit outcome is unknown is failed rather than guessed at. The
 *  user is the only one who can look at the store, so tell them what to look for. */
export const SUBMIT_OUTCOME_UNKNOWN =
  'the process stopped while submitting to Shopify, so this operation may or may not ' +
  'have reached the store. For an import, check the store for its qa-import records ' +
  'and run QA cleanup if any are there before re-running; a cleanup can simply be re-run.';

/**
 * THE DECISION. Pure, and it deliberately takes nothing from the shop.
 *
 * A PENDING row is "written, but we have no bulk operation id for it". The id is
 * minted by Shopify and only exists once bulkOperationRunMutation's response comes
 * back, so no transaction can make "submit" and "record the id" atomic — there is
 * always a window where Shopify has accepted an op we have no id for.
 *
 * What we CAN record before the side effect is intent: submitAttemptedAt is written
 * immediately before the mutation is called. That splits PENDING rows cleanly:
 *
 *   1. submitAttemptedAt NULL — we provably never called bulkOperationRunMutation.
 *      No records exist for this row. → RELAUNCH.
 *
 *   2. submitAttemptedAt set — the call may or may not have reached Shopify.
 *      → FAIL, loudly, with what to check.
 *
 * Case 2 used to ADOPT the shop's newest bulk operation if it postdated the row,
 * on the theory that Shopify runs one bulk mutation per shop. That theory was
 * never sufficient (any op created AFTER the crash — another run on the store once
 * its lock expired, another instance, resume's own relaunch of a different row —
 * also postdates the row), and from API 2026-01 Shopify runs up to FIVE bulk
 * operations of each type per app per shop concurrently, so "newest" says nothing
 * about "mine". The shop cannot tell us either: bulkOperationRunMutation accepts a
 * clientIdentifier, but BulkOperation exposes no way to read it back. Adopting a
 * stranger's op misattributes every row; relaunching over an op that did land
 * duplicates the import. Failing is the only answer that is never wrong.
 */
export function decideResume(row: { submitAttemptedAt: Date | null }): ResumeDecision {
  if (row.submitAttemptedAt === null) return { action: 'relaunch' };
  return { action: 'fail', reason: SUBMIT_OUTCOME_UNKNOWN };
}

/** One interrupted row, whichever table it came from. */
export interface ResumableRow {
  id: string;
  storeId: string | null;
  createdAt: Date;
  submitAttemptedAt: Date | null;
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
  /** Re-run the submit for a row whose op never reached Shopify. */
  relaunch(id: string): Promise<void>;
  /** Give up on this row, with a reason the user can act on. */
  fail(id: string, error: string): Promise<void>;
  /** Who this row is, as far as the store busy-lock is concerned. Resume must hold
   *  the store's lock before it touches it — see resumeStore. */
  lockOwner(row: ResumableRow): StoreLockOwner;
}

export interface ResumeSummary {
  relaunched: number;
  failed: number;
  skipped: number;
}

/** Resolve every interrupted row in one store. */
export async function resumeStore(store: ResumableStore): Promise<ResumeSummary> {
  const summary: ResumeSummary = { relaunched: 0, failed: 0, skipped: 0 };
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

  const rows = await store.findResumable(staleBefore);

  // CAN we tell whose row is whose?
  //
  // The ownership skip below asks "is this store missing from MY config?" That is
  // only a meaningful question when this instance HAS a usable config. If the
  // store list is empty or failed to parse, resolveStoreId returns null for every
  // store alike, the skip matches every row, and resume silently does nothing —
  // turning a misconfiguration into a no-op with no error anywhere, which is the
  // failure mode this whole service exists to prevent.
  //
  // So ownership is only judged when there is something to judge against.
  // Otherwise every row falls through to the normal path, which fails it loudly
  // with a real reason ("...is not configured") instead of quietly ignoring it.
  const storesConfig = getShopifyStoresConfig();
  const canJudgeOwnership = storesConfig.ok && storesConfig.stores.length > 0;

  for (const row of rows) {
    // NOT OURS — leave it alone, and do NOT claim it.
    //
    // Deployed one-instance-per-colleague against a SHARED database, each instance
    // holds tokens for only its own stores, but findResumable sees every PENDING row
    // in the database. Without this guard, any instance rebooting would claim a
    // colleague's healthy in-flight row, fail to build a client for a store it has no
    // token for, and the catch below would mark their run FAILED — while their import
    // is still running perfectly at Shopify, and their own instance is still driving
    // it. The claim is what makes it destructive, so the skip has to come first.
    //
    // A row with a NULL storeId is a legacy single-store row and is left to the
    // existing path, which fails it honestly.
    if (canJudgeOwnership && row.storeId && !resolveStoreId(row.storeId)) {
      summary.skipped++;
      continue;
    }

    // Claim first. Two overlapping boots (a rolling deploy) must not both work
    // the same row — that is how you get two bulk ops submitted for one job.
    const claimed = await store.claim(row.id, staleBefore);
    if (!claimed) {
      summary.skipped++;
      continue;
    }

    try {
      // Re-take the store's busy-lock before touching it.
      //
      // The lock row survives the crash (it is in Postgres, not in memory), and
      // acquire is re-entrant for the same owner, so the normal case is that we
      // simply re-take a lock we still held. It matters in the case where we did
      // NOT: if the process was down long enough for this row's lock to expire and
      // someone else to claim the store, resuming would drop a second operation
      // onto a store another colleague is actively using. StoreBusyError is thrown,
      // the catch below fails the row, and the user is told to re-run it — which is
      // the honest outcome, and far better than the collision.
      const lockStoreId = resolveStoreId(row.storeId ?? undefined);
      if (lockStoreId) {
        await acquireStoreLock(prisma, lockStoreId, store.lockOwner(row));
      }

      // Nothing on the shop is consulted: see decideResume for why the shop
      // cannot tell us which bulk operation is ours.
      const decision = decideResume(row);

      if (decision.action === 'fail') {
        await store.fail(row.id, `Interrupted and could not be resumed: ${decision.reason}`);
        summary.failed++;
        console.error(
          `[resume] ${store.label} ${row.id}: submit outcome unknown — failed, not guessed`,
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
  const total: ResumeSummary = { relaunched: 0, failed: 0, skipped: 0 };

  const [{ customerResumableStores }, { productResumableStores }, { cleanupResumableStores }] =
    await Promise.all([
      import('./shopifyImport.service'),
      import('./productImport.service'),
      import('./cleanupRun.service'),
    ]);

  const stores = [
    ...customerResumableStores(),
    ...productResumableStores(),
    ...cleanupResumableStores(),
  ];

  for (const store of stores) {
    const s = await resumeStore(store);
    total.relaunched += s.relaunched;
    total.failed += s.failed;
    total.skipped += s.skipped;
  }

  const touched = total.relaunched + total.failed;
  if (touched > 0) {
    console.log(
      `[resume] resolved ${touched} interrupted import row(s): ` +
        `${total.relaunched} relaunched, ${total.failed} failed`,
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
  findMany(args: unknown): Promise<ResumableRow[]>;
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
    select: { id: true, storeId: true, createdAt: true, submitAttemptedAt: true },
  });
}

/**
 * Record intent BEFORE calling bulkOperationRunMutation. Every submit path calls
 * this immediately before the mutation (after the staged upload, which creates
 * nothing in the store), so a PENDING row without it provably never reached
 * Shopify. See decideResume.
 */
export async function markSubmitAttempt(delegate: ResumeDelegate, id: string): Promise<void> {
  await delegate.updateMany({
    where: { id, status: 'PENDING' },
    data: { submitAttemptedAt: new Date() },
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
