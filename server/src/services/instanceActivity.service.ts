import type { Request, Response, NextFunction } from 'express';
import prisma from '../db/prisma';
import { getSafeShopifyStores } from '../config/shopify';
import { liveStoreLocks, shareOwner } from './storeLock.service';
import { TERMINAL_BULK_STATUSES } from './shopifyBulk';
import { normalizeActor } from './actionLog.service';

// ─────────────────────────────────────────────────────────────────────────────
// What is this instance's SE doing? Feeds the fleet status page (deploy/monitor),
// which answers two questions per SE: how much have they used the tool, and are
// they using it RIGHT NOW.
//
// ── Two attributions, on purpose ────────────────────────────────────────────
//
// RUN COUNTS go by `createdBy` matched against this instance's owner, the same
// case-insensitive match the history filter uses. That is a typed label, not a
// login, so a colleague who types someone else's name is counted as them.
//
// WHAT IS RUNNING goes by STORE. Every instance holds only its own SE's stores
// (SHOPIFY_TEST_STORES), and the store lock is taken for every import and cleanup,
// so a busy store on this instance is this SE's operation whatever name was typed —
// including cleanups, which record no name at all.
//
// ── Counts and codes only ───────────────────────────────────────────────────
//
// The status page has no login and sits on an open LAN. Nothing here may carry a
// file name, ticket name, or any CSV value: file names routinely name the client.
// ─────────────────────────────────────────────────────────────────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Paths the fleet monitor itself polls. A request to one of these is the monitor
// asking, not the SE working, so it must not move "last active".
const MONITOR_PATHS = new Set(['/api/health', '/api/instance', '/api/instance/activity']);

let lastRequestAt: number | null = null;

/** Remember when this instance last served its SE. In memory only: it resets on
 *  restart, which reads as "no activity since the restart" — true, and harmless. */
export function trackActivity(req: Request, _res: Response, next: NextFunction): void {
  if (req.path.startsWith('/api/') && !MONITOR_PATHS.has(req.path)) {
    lastRequestAt = Date.now();
  }
  next();
}

/** Test seam: the tracker is module state. */
export function resetActivityTracking(): void {
  lastRequestAt = null;
}

export interface RunCounts {
  total: number;
  last7d: number;
}

export interface ActiveOperation {
  storeId: string;
  shop: string | null;
  operation: string;
  /** Rows (customers) or products in this store's slice of a batch; null for a
   *  single-store run, whose size is not on the run row. */
  size: number | null;
  startedAt: string;
  /** No live store lock. The lock is renewed by the status poll a watching browser
   *  drives, so without one nobody is watching: Shopify may still be working, but
   *  our record of the run will not move until someone opens it again. */
  stale: boolean;
}

export interface InstanceActivity {
  owner: string | null;
  lastRequestAt: string | null;
  runs: {
    customerValidations: RunCounts;
    customerImports: RunCounts;
    productUploads: RunCounts;
    productImports: RunCounts;
  } | null;
  active: ActiveOperation[];
}

export async function getInstanceActivity(now = Date.now()): Promise<InstanceActivity> {
  const owner = normalizeActor(process.env.QA_INSTANCE_OWNER ?? '') || null;
  const weekAgo = new Date(now - WEEK_MS);

  let runs: InstanceActivity['runs'] = null;
  if (owner) {
    const by = { equals: owner, mode: 'insensitive' as const };
    const recent = { gte: weekAgo };
    const [cv, cv7, ci, ci7, pu, pu7, pi, pi7] = await prisma.$transaction([
      prisma.validationRun.count({ where: { createdBy: by } }),
      prisma.validationRun.count({ where: { createdBy: by, createdAt: recent } }),
      prisma.importRun.count({ where: { validationRun: { createdBy: by } } }),
      prisma.importRun.count({ where: { validationRun: { createdBy: by }, createdAt: recent } }),
      prisma.productUploadRun.count({ where: { createdBy: by } }),
      prisma.productUploadRun.count({ where: { createdBy: by, createdAt: recent } }),
      prisma.productImportRun.count({ where: { uploadRun: { createdBy: by } } }),
      prisma.productImportRun.count({ where: { uploadRun: { createdBy: by }, createdAt: recent } }),
    ]);
    runs = {
      customerValidations: { total: cv, last7d: cv7 },
      customerImports: { total: ci, last7d: ci7 },
      productUploads: { total: pu, last7d: pu7 },
      productImports: { total: pi, last7d: pi7 },
    };
  }

  const myStores = new Map(getSafeShopifyStores().map((s) => [s.id, s.shop]));
  const storeIds = [...myStores.keys()];
  const open = { storeId: { in: storeIds }, status: { notIn: TERMINAL_BULK_STATUSES } };
  const pick = { id: true, storeId: true, createdAt: true } as const;

  // Read the RUN tables, not the locks. An expired lock counts as finished (so it
  // cannot wedge a store), which means an import nobody is watching drops out of
  // the locks after the TTL while Shopify is still working on it. The run row stays
  // non-terminal until someone opens it again, so that is where "running" lives.
  // Batches are listed per store: the job carries the store, the parent does not. A
  // store runs up to k jobs of one run, folded below into one entry per store.
  const [ci, cj, pi, pj, cl, locks] = await Promise.all([
    storeIds.length ? prisma.importRun.findMany({ where: open, select: pick }) : [],
    storeIds.length ? prisma.importBatchJob.findMany({ where: open, select: { ...pick, importRunId: true, rowCount: true } }) : [],
    storeIds.length ? prisma.productImportRun.findMany({ where: open, select: pick }) : [],
    storeIds.length ? prisma.productImportJob.findMany({ where: open, select: { ...pick, importRunId: true, productCount: true } }) : [],
    storeIds.length ? prisma.cleanupRun.findMany({ where: open, select: { ...pick, entity: true } }) : [],
    liveStoreLocks(),
  ]);
  const watched = new Set(locks.map((l) => l.ownerId));

  // A store's share of a batch is ONE operation to the SE however many jobs it was
  // split into: sum their sizes, start at the earliest, and judge "watched" by the
  // share's lock (jobs never own one; their share does).
  const shares = <J extends { id: string; importRunId: string; storeId: string | null; createdAt: Date }>(
    jobs: J[],
    sizeOf: (j: J) => number,
  ) => {
    const byShare = new Map<string, { id: string; storeId: string | null; createdAt: Date; size: number }>();
    for (const j of jobs) {
      const key = `${j.importRunId}:${j.storeId}`;
      const seen = byShare.get(key);
      if (seen) {
        seen.size += sizeOf(j);
        if (j.createdAt < seen.createdAt) seen.createdAt = j.createdAt;
      } else {
        byShare.set(key, {
          id: j.storeId ? shareOwner(j.importRunId, j.storeId) : j.id,
          storeId: j.storeId,
          createdAt: j.createdAt,
          size: sizeOf(j),
        });
      }
    }
    return [...byShare.values()];
  };

  const rows: { id: string; storeId: string | null; createdAt: Date; operation: string; size: number | null }[] = [
    ...ci.map((r) => ({ ...r, operation: 'customer import', size: null })),
    ...shares(cj, (j) => j.rowCount).map((r) => ({ ...r, operation: 'customer import' })),
    ...pi.map((r) => ({ ...r, operation: 'product import', size: null })),
    ...shares(pj, (j) => j.productCount).map((r) => ({ ...r, operation: 'product import' })),
    ...cl.map((r) => ({ ...r, operation: `${r.entity === 'PRODUCT' ? 'product' : 'customer'} cleanup`, size: null })),
  ];

  const active = rows
    .map((r) => ({
      storeId: r.storeId ?? '',
      shop: (r.storeId && myStores.get(r.storeId)) ?? null,
      operation: r.operation,
      size: r.size,
      startedAt: r.createdAt.toISOString(),
      stale: !watched.has(r.id),
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  return {
    owner,
    lastRequestAt: lastRequestAt === null ? null : new Date(lastRequestAt).toISOString(),
    runs,
    active,
  };
}
