import prisma from '../db/prisma';

// One Shopify-rejected row, with enough detail to explain WHY it was rejected.
export interface RejectedRow {
  rowNumber: number;
  shopifyField: string | null;
  shopifyCode: string | null;
  message: string | null;
}

export interface PerStoreResult {
  storeId: string | null;
  shopDomain: string;
  total: number;
  accepted: number;
  rejected: number;
}

// What the import actually did. This tool answers one question — will Shopify
// take this file? — so the payload is accepted, rejected, and Shopify's own
// reason per rejected row. It deliberately says nothing about how our pre-check
// scored: whether a rule was too strict or missing is a question for whoever
// maintains the validators, not for the person running a migration.
export interface ImportFeedback {
  importRunId: string;
  validationId: string;
  // Store this import actually ran against (null = default store / legacy run).
  storeId: string | null;
  shopDomain: string;
  status: string;
  // Reason for a terminal failure (FAILED/CANCELED/EXPIRED); null otherwise.
  error: string | null;
  successCount: number;
  errorCount: number;
  totalRows: number;
  createdAt: Date;
  // Every row Shopify rejected (capped at REJECTED_LIMIT), ordered by row number,
  // with field/code/message so the UI can show what was rejected and why.
  rejectedRows: RejectedRow[];
  // Per-store accepted/rejected split (one entry per store for a batch; a single
  // entry for a single-store run).
  perStore: PerStoreResult[];
}

/**
 * Label a result's store with its shop domain, for the per-store breakdown and the
 * report's Store column. Shared by both flows (customers and products are twins).
 *
 * A batch knows each store's domain from its jobs. A single-store run has no jobs
 * — its domain is the run's own shopDomain — and looking it up among the jobs used
 * to find nothing and print the raw store id ("store3") where every batch printed
 * "acme-qa.myshopify.com".
 */
export function storeLabeller(run: {
  storeId: string | null;
  shopDomain: string;
  batchJobs: { storeId: string | null; shopDomain: string }[];
}): (storeId: string | null) => string {
  const shopByStore = new Map<string, string>();
  for (const job of run.batchJobs) {
    if (job.storeId) shopByStore.set(job.storeId, job.shopDomain);
  }
  return (storeId) => {
    if (!storeId) return run.shopDomain; // legacy row with no store recorded
    const fromJob = shopByStore.get(storeId);
    if (fromJob) return fromJob;
    if (storeId === run.storeId) return run.shopDomain;
    return storeId;
  };
}

// Rejections are the highest-value detail, so surface a good number of them
// before truncating (the UI shows the overflow count).
const REJECTED_LIMIT = 200;

export async function getImportFeedback(
  importRunId: string,
): Promise<ImportFeedback | null> {
  // Called on every status poll, so it must not load a large import's every
  // result row: the counts are aggregated in the database and only the capped
  // rejected list is read.
  const run = await prisma.importRun.findUnique({
    where: { id: importRunId },
    include: { batchJobs: { select: { storeId: true, shopDomain: true } } },
  });
  if (!run) return null;

  const [rejected, counts] = await Promise.all([
    prisma.importRowResult.findMany({
      where: { importRunId, accepted: false },
      orderBy: { rowNumber: 'asc' },
      take: REJECTED_LIMIT,
      select: { rowNumber: true, shopifyField: true, shopifyCode: true, message: true },
    }),
    prisma.importRowResult.groupBy({
      by: ['storeId', 'accepted'],
      where: { importRunId },
      _count: { _all: true },
    }),
  ]);
  const rejectedRows: RejectedRow[] = rejected;

  // Per-store split, labelled with the store's shop domain.
  const shopLabel = storeLabeller(run);
  const perStoreMap = new Map<string, PerStoreResult>();
  let totalRows = 0;
  for (const c of counts) {
    const n = c._count._all;
    totalRows += n;
    const key = c.storeId ?? '';
    let entry = perStoreMap.get(key);
    if (!entry) {
      entry = { storeId: c.storeId, shopDomain: shopLabel(c.storeId), total: 0, accepted: 0, rejected: 0 };
      perStoreMap.set(key, entry);
    }
    entry.total += n;
    if (c.accepted) entry.accepted += n;
    else entry.rejected += n;
  }
  const perStore = [...perStoreMap.values()].sort((a, b) => b.total - a.total);

  return {
    importRunId: run.id,
    validationId: run.validationId,
    storeId: run.storeId,
    shopDomain: run.shopDomain,
    status: run.status,
    error: run.error,
    successCount: run.successCount,
    errorCount: run.errorCount,
    totalRows,
    createdAt: run.createdAt,
    rejectedRows,
    perStore,
  };
}
