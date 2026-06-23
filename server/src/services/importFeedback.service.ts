import prisma from '../db/prisma';

// Which existing validator (if any) already owns a given Shopify (field, code).
// If a row lands in a gap whose key IS covered here, the validator exists but
// missed this row (a rule bug/gap); if it's NOT here, no rule covers it at all.
export const VALIDATOR_COVERAGE: Record<string, string> = {
  'email|INVALID': 'InvalidEmailRule',
  'email|TAKEN': 'DuplicateEmailRule',
  'email|BLANK': 'MissingContactRule',
  'phone|INVALID': 'InvalidPhoneRule',
  'phone|TAKEN': 'DuplicatePhoneRule',
  'phone|BLANK': 'MissingContactRule',
  'countryCode|INVALID': 'AddressCompletenessRule',
  'provinceCode|INVALID': 'ProvinceCodeRule',
  'zip|INVALID': 'PostalCodeRule',
};

export function coverageKey(field: string | null, code: string | null): string {
  return `${field ?? '(none)'}|${code ?? '(none)'}`;
}

export interface BucketRow {
  rowNumber: number;
  shopifyField: string | null;
  shopifyCode: string | null;
  message: string | null;
}

// One Shopify-rejected row, with enough detail to explain WHY it was rejected.
// flaggedByValidator distinguishes a row our rules already caught (rule working)
// from a row Shopify rejected that we missed (a rule gap).
export interface RejectedRow {
  rowNumber: number;
  shopifyField: string | null;
  shopifyCode: string | null;
  message: string | null;
  flaggedByValidator: boolean;
}

export interface FourBucketSummary {
  // rejected by Shopify but NOT flagged by our validator → missing rule (highest value)
  missingRule: { count: number; rows: BucketRow[] };
  // flagged by our validator but accepted by Shopify → false positive (too strict)
  falsePositive: { count: number; rows: BucketRow[] };
  // rejected + flagged → confirmation (rule working)
  confirmedReject: { count: number };
  // accepted + not flagged → confirmation (clean)
  confirmedClean: { count: number };
}

export interface RuleGap {
  shopifyField: string | null;
  shopifyCode: string | null;
  count: number;
  sampleMessages: string[];
  sampleRowNumbers: number[];
  existingValidator: string | null;
}

export interface PerStoreResult {
  storeId: string | null;
  shopDomain: string;
  total: number;
  accepted: number;
  rejected: number;
}

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
  summary: FourBucketSummary;
  ruleGaps: RuleGap[];
  // Every row Shopify rejected (capped at REJECTED_LIMIT), ordered by row number,
  // with field/code/message so the UI can show what was rejected and why.
  rejectedRows: RejectedRow[];
  // Per-store accepted/rejected split (one entry per store for a batch; a single
  // entry for a single-store run).
  perStore: PerStoreResult[];
}

const SAMPLE_LIMIT = 25;
// Rejections are the highest-value detail, so surface more of them than the
// per-bucket samples before truncating (UI shows the overflow count).
const REJECTED_LIMIT = 200;

function aggregateRuleGaps(
  rows: { rowNumber: number; shopifyField: string | null; shopifyCode: string | null; message: string | null }[],
): RuleGap[] {
  const groups = new Map<string, RuleGap>();
  for (const r of rows) {
    const key = `${r.shopifyField ?? ''}|${r.shopifyCode ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        shopifyField: r.shopifyField,
        shopifyCode: r.shopifyCode,
        count: 0,
        sampleMessages: [],
        sampleRowNumbers: [],
        existingValidator: VALIDATOR_COVERAGE[coverageKey(r.shopifyField, r.shopifyCode)] ?? null,
      };
      groups.set(key, g);
    }
    g.count++;
    if (r.message && g.sampleMessages.length < 3 && !g.sampleMessages.includes(r.message)) {
      g.sampleMessages.push(r.message);
    }
    if (g.sampleRowNumbers.length < 10) g.sampleRowNumbers.push(r.rowNumber);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export async function getImportFeedback(
  importRunId: string,
): Promise<ImportFeedback | null> {
  const run = await prisma.importRun.findUnique({
    where: { id: importRunId },
    include: { rowResults: true, batchJobs: true },
  });
  if (!run) return null;

  const missingRows = run.rowResults.filter(
    (r) => !r.accepted && !r.wasFlaggedByValidator,
  );
  const falsePositiveRows = run.rowResults.filter(
    (r) => r.accepted && r.wasFlaggedByValidator,
  );
  const confirmedReject = run.rowResults.filter(
    (r) => !r.accepted && r.wasFlaggedByValidator,
  ).length;
  const confirmedClean = run.rowResults.filter(
    (r) => r.accepted && !r.wasFlaggedByValidator,
  ).length;

  const toBucketRow = (r: (typeof run.rowResults)[number]): BucketRow => ({
    rowNumber: r.rowNumber,
    shopifyField: r.shopifyField,
    shopifyCode: r.shopifyCode,
    message: r.message,
  });

  // Every rejection (both flagged and missed), ordered by row number, for the
  // "what was rejected and why" table.
  const rejectedRows: RejectedRow[] = run.rowResults
    .filter((r) => !r.accepted)
    .sort((a, b) => a.rowNumber - b.rowNumber)
    .slice(0, REJECTED_LIMIT)
    .map((r) => ({
      rowNumber: r.rowNumber,
      shopifyField: r.shopifyField,
      shopifyCode: r.shopifyCode,
      message: r.message,
      flaggedByValidator: r.wasFlaggedByValidator,
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
    summary: {
      missingRule: {
        count: missingRows.length,
        rows: missingRows.slice(0, SAMPLE_LIMIT).map(toBucketRow),
      },
      falsePositive: {
        count: falsePositiveRows.length,
        rows: falsePositiveRows.slice(0, SAMPLE_LIMIT).map(toBucketRow),
      },
      confirmedReject: { count: confirmedReject },
      confirmedClean: { count: confirmedClean },
    },
    ruleGaps: aggregateRuleGaps(missingRows),
    rejectedRows,
    perStore,
  };
}

/**
 * Cross-run rule-gap backlog: every row Shopify rejected that no validator
 * flagged, grouped by (field, code) across ALL import runs. Highest-count
 * groups without an existing validator are the most valuable new rules.
 */
export async function getRuleGapBacklog(): Promise<RuleGap[]> {
  const rows = await prisma.importRowResult.findMany({
    where: { accepted: false, wasFlaggedByValidator: false },
    select: { rowNumber: true, shopifyField: true, shopifyCode: true, message: true },
  });
  return aggregateRuleGaps(rows);
}
