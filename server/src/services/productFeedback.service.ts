import prisma from '../db/prisma';

// Without a validator there's nothing to compare against, so there is no
// four-bucket report. The feedback IS the import truth: total / accepted /
// rejected, with rejections grouped by the real productSet (field, code), plus a
// per-store breakdown for parallel runs.

export interface RejectionGroup {
  shopifyField: string | null;
  shopifyCode: string | null;
  count: number;
  // Up to 3 distinct Shopify messages and up to 10 example Handles for this group.
  sampleMessages: string[];
  sampleHandles: string[];
}

export interface PerStoreResult {
  storeId: string | null;
  shopDomain: string;
  total: number;
  accepted: number;
  rejected: number;
}

export interface ProductImportFeedback {
  importRunId: string;
  uploadId: string;
  // Store this import actually ran against (null = default store, or a batch
  // parent whose stores live on its jobs).
  storeId: string | null;
  shopDomain: string;
  status: string;
  // Reason for a terminal failure (FAILED/CANCELED/EXPIRED); null otherwise.
  error: string | null;
  successCount: number;
  errorCount: number;
  totalProducts: number;
  accepted: number;
  rejected: number;
  createdAt: Date;
  // Rejections grouped by (field, code), highest-count first.
  rejectionGroups: RejectionGroup[];
  // Per-store accepted/rejected split (one entry per store for a batch; a single
  // entry for a single-store run).
  perStore: PerStoreResult[];
}

function aggregateRejections(
  rows: {
    handle: string;
    shopifyField: string | null;
    shopifyCode: string | null;
    message: string | null;
  }[],
): RejectionGroup[] {
  const groups = new Map<string, RejectionGroup>();
  for (const r of rows) {
    const key = `${r.shopifyField ?? ''}|${r.shopifyCode ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        shopifyField: r.shopifyField,
        shopifyCode: r.shopifyCode,
        count: 0,
        sampleMessages: [],
        sampleHandles: [],
      };
      groups.set(key, g);
    }
    g.count++;
    if (r.message && g.sampleMessages.length < 3 && !g.sampleMessages.includes(r.message)) {
      g.sampleMessages.push(r.message);
    }
    if (g.sampleHandles.length < 10 && !g.sampleHandles.includes(r.handle)) {
      g.sampleHandles.push(r.handle);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export async function getProductImportFeedback(
  importRunId: string,
): Promise<ProductImportFeedback | null> {
  const run = await prisma.productImportRun.findUnique({
    where: { id: importRunId },
    include: { rowResults: true, batchJobs: true },
  });
  if (!run) return null;

  const rejectedRows = run.rowResults.filter((r) => !r.accepted);
  const accepted = run.rowResults.length - rejectedRows.length;

  // Per-store split. Label each store via its batch job; fall back to the run's
  // own shopDomain for the single (null storeId) group.
  const shopByStore = new Map<string, string>();
  for (const job of run.batchJobs) {
    if (job.storeId) shopByStore.set(job.storeId, job.shopDomain);
  }
  const perStoreMap = new Map<string, PerStoreResult>();
  for (const r of run.rowResults) {
    const key = r.storeId ?? '';
    let entry = perStoreMap.get(key);
    if (!entry) {
      entry = {
        storeId: r.storeId,
        shopDomain: r.storeId ? shopByStore.get(r.storeId) ?? r.storeId : run.shopDomain,
        total: 0,
        accepted: 0,
        rejected: 0,
      };
      perStoreMap.set(key, entry);
    }
    entry.total++;
    if (r.accepted) entry.accepted++;
    else entry.rejected++;
  }
  const perStore = [...perStoreMap.values()].sort((a, b) => b.total - a.total);

  return {
    importRunId: run.id,
    uploadId: run.uploadId,
    storeId: run.storeId,
    shopDomain: run.shopDomain,
    status: run.status,
    error: run.error,
    successCount: run.successCount,
    errorCount: run.errorCount,
    totalProducts: run.rowResults.length,
    accepted,
    rejected: rejectedRows.length,
    createdAt: run.createdAt,
    rejectionGroups: aggregateRejections(rejectedRows),
    perStore,
  };
}
