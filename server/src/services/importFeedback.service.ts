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

// Rejections are the highest-value detail, so surface a good number of them
// before truncating (the UI shows the overflow count).
const REJECTED_LIMIT = 200;

export async function getImportFeedback(
  importRunId: string,
): Promise<ImportFeedback | null> {
  const run = await prisma.importRun.findUnique({
    where: { id: importRunId },
    include: { rowResults: true, batchJobs: true },
  });
  if (!run) return null;

  const rejectedRows: RejectedRow[] = run.rowResults
    .filter((r) => !r.accepted)
    .sort((a, b) => a.rowNumber - b.rowNumber)
    .slice(0, REJECTED_LIMIT)
    .map((r) => ({
      rowNumber: r.rowNumber,
      shopifyField: r.shopifyField,
      shopifyCode: r.shopifyCode,
      message: r.message,
    }));

  // Per-store split. Label each store via its batch job; fall back to the run's
  // own shopDomain for the single/legacy (null storeId) group.
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
    validationId: run.validationId,
    storeId: run.storeId,
    shopDomain: run.shopDomain,
    status: run.status,
    error: run.error,
    successCount: run.successCount,
    errorCount: run.errorCount,
    totalRows: run.rowResults.length,
    createdAt: run.createdAt,
    rejectedRows,
    perStore,
  };
}
