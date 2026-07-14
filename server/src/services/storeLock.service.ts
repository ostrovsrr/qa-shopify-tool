import type { Prisma, StoreLock } from '@prisma/client';
import prisma from '../db/prisma';
import { TERMINAL_BULK_STATUSES } from './shopifyBulk';

// ─────────────────────────────────────────────────────────────────────────────
// THE STORE BUSY-LOCK.
//
// One operation per Shopify store at a time. The unit of contention is the STORE,
// not the import and not the entity:
//
//   - Shopify allows exactly ONE bulk mutation per SHOP. Not one per shop per
//     entity. So a customer import and a product import aimed at the same store
//     really do collide — Shopify rejects the second with a confusing "already in
//     progress" rather than queueing it. Keying the lock on (storeId, entity)
//     would wave that collision straight through. The key is bare storeId.
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

/** Prisma client or an interactive-transaction handle — acquire runs inside the
 *  caller's transaction so taking the lock and pre-persisting the run are atomic. */
type Db = Prisma.TransactionClient | typeof prisma;

function ttlFrom(now: number): Date {
  return new Date(now + STORE_LOCK_TTL_MS);
}

/**
 * Is the row that holds this lock still actually working?
 *
 * This is what makes a missed release survivable. Releases are explicit and there
 * are a dozen terminal transitions across the two flows plus cleanup; forgetting one
 * would otherwise wedge a store until the TTL ran out. Instead, an acquirer that
 * finds a lock held by an already-terminal (or deleted) row simply takes it. The
 * explicit release is then an optimization — it frees the store immediately and lets
 * us name the holder in the error — not a correctness requirement.
 */
async function holderIsFinished(db: Db, lock: StoreLock): Promise<boolean> {
  if (lock.expiresAt.getTime() <= Date.now()) return true;

  const id = lock.ownerId;
  const row = await (async (): Promise<{ status: string } | null> => {
    switch (lock.ownerType as StoreLockOwnerType) {
      case 'IMPORT_RUN':
        return db.importRun.findUnique({ where: { id }, select: { status: true } });
      case 'IMPORT_JOB':
        return db.importBatchJob.findUnique({ where: { id }, select: { status: true } });
      case 'PRODUCT_IMPORT_RUN':
        return db.productImportRun.findUnique({ where: { id }, select: { status: true } });
      case 'PRODUCT_IMPORT_JOB':
        return db.productImportJob.findUnique({ where: { id }, select: { status: true } });
      case 'CLEANUP_RUN':
        return db.cleanupRun.findUnique({ where: { id }, select: { status: true } });
      default:
        // Unknown owner type (an old row from a future/older schema): don't let it
        // hold a store hostage.
        return null;
    }
  })();

  // Owner row gone (the run was deleted) → nothing is running. Owner terminal →
  // nothing is running.
  if (!row) return true;
  return TERMINAL_BULK_STATUSES.includes(row.status);
}

function busyMessage(lock: StoreLock): string {
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
 */
export async function acquireStoreLock(
  db: Db,
  storeId: string,
  owner: StoreLockOwner,
): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`store-lock:${storeId}`}))`;

  const existing = await db.storeLock.findUnique({ where: { storeId } });
  if (existing && existing.ownerId !== owner.ownerId && !(await holderIsFinished(db, existing))) {
    throw new StoreBusyError(busyMessage(existing), [storeId]);
  }

  const now = Date.now();
  await db.storeLock.upsert({
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
  db: Db,
  storeIds: string[],
  ownerFor: (storeId: string) => StoreLockOwner,
): Promise<void> {
  for (const storeId of [...new Set(storeIds)].sort()) {
    await acquireStoreLock(db, storeId, ownerFor(storeId));
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
  const locks = await prisma.storeLock.findMany();
  const live: { storeId: string; operation: string; acquiredAt: Date }[] = [];
  for (const lock of locks) {
    if (await holderIsFinished(prisma, lock)) continue;
    live.push({ storeId: lock.storeId, operation: lock.operation, acquiredAt: lock.acquiredAt });
  }
  return live;
}
