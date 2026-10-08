import type { Prisma, StoreLock } from '@prisma/client';
import prisma from '../db/prisma';
import { TERMINAL_BULK_STATUSES } from './shopifyBulk';

// ─────────────────────────────────────────────────────────────────────────────
// THE STORE BUSY-LOCK.
//
// One operation per Shopify store at a time. The unit of contention is the STORE,
// not the import and not the entity:
//
//   - Shopify will NOT keep two operations on one store apart for us. From API
//     2026-01 (what this repo pins) an app may run up to FIVE bulk mutations per
//     SHOP at once, across entities. So a customer import and a product import
//     aimed at the same store are both accepted and silently interleave. This lock,
//     not Shopify, is what serializes them, and keying it on (storeId, entity)
//     would wave that overlap straight through. The key is bare storeId.
//
//   - /cleanup-qa and /cleanup-qa-products delete BY TAG ACROSS AN ENTIRE STORE.
//     They are the highest-blast-radius routes in the app. A cleanup racing an
//     import to the same store deletes the very records that import is about to
//     reconcile against. Shopify's per-shop limit does NOT save us here: the small
//     teardown path (<= bulkThreshold ids) deletes serially, not as a bulk op, so
//     it is invisible to that limit. This lock is the only thing standing between
//     those two.
//
// A batch import across N stores takes N locks, one per store. Parallelism across
// DIFFERENT stores is completely preserved; the lock only bites when two operations
// want the SAME store, which is exactly the case we want blocked.
//
// Serves the customer and product flows alike — they are twins.
// ─────────────────────────────────────────────────────────────────────────────

/** Which table `ownerId` points at, so a later acquirer can ask whether the holder
 *  is still alive. */
export type StoreLockOwnerType =
  | 'IMPORT_RUN'
  | 'IMPORT_JOB'
  | 'PRODUCT_IMPORT_RUN'
  | 'PRODUCT_IMPORT_JOB'
  | 'CLEANUP_RUN';

export interface StoreLockOwner {
  ownerType: StoreLockOwnerType;
  ownerId: string;
  /** Human phrase for the busy message: "a customer import", "a product cleanup". */
  operation: string;
}

/**
 * How long a lock survives without being renewed.
 *
 * A run is only ever advanced by a status poll, so an operation whose last watcher
 * closed their browser can sit non-terminal forever with nobody to finalize it —
 * and it would hold its store forever with it. The TTL is the backstop for exactly
 * that. It is renewed on every poll (renewStoreLock), so a live operation never
 * loses its lock; the ceiling only matters once nobody is looking.
 */
export const STORE_LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Raised when a store is already busy. The controllers turn this into a 409. */
export class StoreBusyError extends Error {
  readonly busyStores: string[];

  constructor(message: string, busyStores: string[]) {
    super(message);
    this.name = 'StoreBusyError';
    this.busyStores = busyStores;
  }
}

/** Prisma client or an interactive-transaction handle, for read-only lookups.
 *  Acquiring takes a transaction handle only — see acquireStoreLock. */
type Db = Prisma.TransactionClient | typeof prisma;

function ttlFrom(now: number): Date {
  return new Date(now + STORE_LOCK_TTL_MS);
}

/** What a lock's holder row says about whether anything is still running. */
interface HolderRow {
  id: string;
  status: string;
  submitAttemptedAt: Date | null;
  bulkOperationId: string | null;
}

type HolderVerdict =
  /** The holder is still working. */
  | 'live'
  /** Nothing is running: the holder is terminal or gone, or the lock expired. */
  | 'finished'
  /** The holder FAILED while submitting, so its bulk op may or may not be running
   *  at Shopify. Honoured until the lock's TTL — see judgeHolder. */
  | 'outcome-unknown';

const HOLDER_SELECT = {
  id: true,
  status: true,
  submitAttemptedAt: true,
  bulkOperationId: true,
} as const;

/**
 * Is the row that holds this lock still actually working?
 *
 * This is what makes a missed release survivable. Releases are explicit and there
 * are a dozen terminal transitions across the two flows plus cleanup; forgetting one
 * would otherwise wedge a store until the TTL ran out. Instead, an acquirer that
 * finds a lock held by an already-terminal (or deleted) row simply takes it. The
 * explicit release is then an optimization — it frees the store immediately and lets
 * us name the holder in the error — not a correctness requirement.
 *
 * ONE EXCEPTION. A holder that is FAILED with submitAttemptedAt set and no
 * bulkOperationId failed WHILE SUBMITTING: the mutation may have reached Shopify and
 * be running right now, and nothing the shop exposes says which op is ours (see
 * decideResume in importResume.service.ts). Its row is terminal but the store is not
 * provably idle, so the lock is honoured until its TTL rather than stolen the moment
 * the row turned FAILED. The paths that end in that state (an ambiguous cleanup
 * submit, resume failing an interrupted row) deliberately leave the lock in place.
 */
function judgeHolder(lock: StoreLock, row: HolderRow | undefined): HolderVerdict {
  if (lock.expiresAt.getTime() <= Date.now()) return 'finished';
  // Owner row gone (the run was deleted, or an unknown owner type from an older or
  // newer schema) → nothing is running; don't let it hold a store hostage.
  if (!row) return 'finished';
  if (!TERMINAL_BULK_STATUSES.includes(row.status)) return 'live';
  if (row.status === 'FAILED' && row.submitAttemptedAt && !row.bulkOperationId) {
    return 'outcome-unknown';
  }
  return 'finished';
}

const holderKey = (ownerType: string, ownerId: string): string => `${ownerType}:${ownerId}`;

/**
 * The holder rows of many locks at once: ONE query per owner table, never one per
 * lock. liveStoreLocks runs on every 15s client poll and every status-page load, so a
 * per-lock lookup there was an N+1 on the hottest read in the app.
 */
async function holderRows(db: Db, locks: StoreLock[]): Promise<Map<string, HolderRow>> {
  const idsOf = (type: StoreLockOwnerType): string[] =>
    locks.filter((l) => l.ownerType === type).map((l) => l.ownerId);
  const lookup = async (
    type: StoreLockOwnerType,
    find: (ids: string[]) => Promise<HolderRow[]>,
  ): Promise<[StoreLockOwnerType, HolderRow[]]> => {
    const ids = idsOf(type);
    return [type, ids.length === 0 ? [] : await find(ids)];
  };

  const groups = await Promise.all([
    lookup('IMPORT_RUN', (ids) =>
      db.importRun.findMany({ where: { id: { in: ids } }, select: HOLDER_SELECT }),
    ),
    lookup('IMPORT_JOB', (ids) =>
      db.importBatchJob.findMany({ where: { id: { in: ids } }, select: HOLDER_SELECT }),
    ),
    lookup('PRODUCT_IMPORT_RUN', (ids) =>
      db.productImportRun.findMany({ where: { id: { in: ids } }, select: HOLDER_SELECT }),
    ),
    lookup('PRODUCT_IMPORT_JOB', (ids) =>
      db.productImportJob.findMany({ where: { id: { in: ids } }, select: HOLDER_SELECT }),
    ),
    lookup('CLEANUP_RUN', (ids) =>
      db.cleanupRun.findMany({ where: { id: { in: ids } }, select: HOLDER_SELECT }),
    ),
  ]);

  const byKey = new Map<string, HolderRow>();
  for (const [type, rows] of groups) {
    for (const row of rows) byKey.set(holderKey(type, row.id), row);
  }
  return byKey;
}

function busyMessage(lock: StoreLock, verdict: HolderVerdict): string {
  if (verdict === 'outcome-unknown') {
    const minutes = Math.max(1, Math.ceil((lock.expiresAt.getTime() - Date.now()) / 60_000));
    return `Store "${lock.storeId}" may still be busy: ${lock.operation} stopped while submitting to Shopify and may still be running there. The store frees itself in ~${minutes} min, or pick another store.`;
  }
  const minutes = Math.max(1, Math.round((Date.now() - lock.acquiredAt.getTime()) / 60_000));
  return `Store "${lock.storeId}" is busy: ${lock.operation} has been running for ~${minutes} min. Wait for it to finish, or pick another store.`;
}

/**
 * Take the lock on ONE store.
 *
 * Serialized with a Postgres transaction-scoped advisory lock keyed on the store, so
 * two requests racing for the same store cannot both read "free" and both write. The
 * advisory lock is released when the transaction ends, whether it commits or not —
 * it guards the check-and-set, it is NOT the store lock itself (that has to outlive
 * the request, since a bulk op runs for minutes while the request returns in
 * seconds).
 *
 * Re-entrant: an owner that already holds the store's lock re-acquires it happily.
 * That is what lets resume-on-boot and a relaunch re-take a lock they may still be
 * holding from before the crash.
 *
 * MUST be called with an interactive-transaction client (prisma.$transaction(tx =>
 * ...)). Called on the bare client, every statement autocommits: the advisory lock
 * is released the instant it is taken and the check-then-upsert below is unguarded.
 * The type cannot express that (a PrismaClient is structurally a TransactionClient),
 * so it is enforced at runtime — the root client has $transaction, a transaction
 * handle does not.
 */
export async function acquireStoreLock(
  tx: Prisma.TransactionClient,
  storeId: string,
  owner: StoreLockOwner,
): Promise<void> {
  if (typeof (tx as { $transaction?: unknown }).$transaction === 'function') {
    throw new Error(
      'acquireStoreLock must run inside prisma.$transaction: on the bare client the advisory lock guards nothing.',
    );
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`store-lock:${storeId}`}))`;

  const existing = await tx.storeLock.findUnique({ where: { storeId } });
  if (existing && existing.ownerId !== owner.ownerId) {
    const verdict = judgeHolder(
      existing,
      (await holderRows(tx, [existing])).get(holderKey(existing.ownerType, existing.ownerId)),
    );
    if (verdict !== 'finished') {
      throw new StoreBusyError(busyMessage(existing, verdict), [storeId]);
    }
  }

  const now = Date.now();
  await tx.storeLock.upsert({
    where: { storeId },
    create: {
      storeId,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      operation: owner.operation,
      expiresAt: ttlFrom(now),
    },
    update: {
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      operation: owner.operation,
      acquiredAt: new Date(now),
      expiresAt: ttlFrom(now),
    },
  });
}

/**
 * Take the locks on SEVERAL stores, all or nothing.
 *
 * A batch import must not fan out to the four free stores and fail the busy one:
 * that is a partial fan-out, which is the exact class of half-done, half-reported
 * work the PENDING pre-persist exists to make impossible. So we take every lock up
 * front, inside the same transaction that pre-persists the run — if any store is
 * busy, the transaction rolls back and NOTHING happened. The user gets one clear
 * "store3 is busy" and can retry or pick another store.
 *
 * Stores are locked in sorted order. Two batches that overlap on two stores would
 * otherwise be able to grab them in opposite orders and deadlock on the advisory
 * locks; a consistent global order makes that impossible.
 */
export async function acquireStoreLocks(
  tx: Prisma.TransactionClient,
  storeIds: string[],
  ownerFor: (storeId: string) => StoreLockOwner,
): Promise<void> {
  for (const storeId of [...new Set(storeIds)].sort()) {
    await acquireStoreLock(tx, storeId, ownerFor(storeId));
  }
}

/**
 * Release whatever locks this owner holds.
 *
 * Scoped by ownerId, so an owner that already lost its lock (expired, then taken
 * over by someone else) cannot rip the store out from under the new holder on its
 * way out.
 */
export async function releaseStoreLock(ownerId: string): Promise<void> {
  await prisma.storeLock.deleteMany({ where: { ownerId } });
}

/**
 * Push the expiry out. Called from the reconcile poll, so an operation that is
 * demonstrably still being watched never hits the TTL backstop no matter how long
 * Shopify takes.
 */
export async function renewStoreLock(ownerId: string): Promise<void> {
  await prisma.storeLock.updateMany({
    where: { ownerId },
    data: { expiresAt: ttlFrom(Date.now()) },
  });
}

/** Which of these stores is busy right now — for showing "in use" in the store
 *  picker before anyone commits to a run. */
export async function busyStores(): Promise<
  { storeId: string; operation: string; acquiredAt: Date }[]
> {
  return (await liveStoreLocks()).map(({ storeId, operation, acquiredAt }) => ({
    storeId,
    operation,
    acquiredAt,
  }));
}

/** Every lock whose holder is still running, expiry included — the fleet status
 *  page uses `expiresAt` to tell a watched operation from one nobody is polling. */
export async function liveStoreLocks(): Promise<StoreLock[]> {
  const locks = await prisma.storeLock.findMany();
  // Expired locks need no lookup at all; the rest are looked up in one query per
  // owner table (holderRows), not one per lock.
  const unexpired = locks.filter((lock) => lock.expiresAt.getTime() > Date.now());
  const holders = await holderRows(prisma, unexpired);
  return unexpired.filter(
    (lock) => judgeHolder(lock, holders.get(holderKey(lock.ownerType, lock.ownerId))) !== 'finished',
  );
}
