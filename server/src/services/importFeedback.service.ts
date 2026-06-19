import prisma from '../db/prisma';

// Which existing validator (if any) already owns a given Shopify (field, code).
// If a row lands in a gap whose key IS covered here, the validator exists but
// missed this row (a rule bug/gap); if it's NOT here, no rule covers it at all.
const VALIDATOR_COVERAGE: Record<string, string> = {
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

function coverageKey(field: string | null, code: string | null): string {
  return `${field ?? '(none)'}|${code ?? '(none)'}`;
}

export interface BucketRow {
  rowNumber: number;
  shopifyField: string | null;
  shopifyCode: string | null;
  message: string | null;
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

export interface ImportFeedback {
  importRunId: string;
  validationId: string;
  shopDomain: string;
  status: string;
  successCount: number;
  errorCount: number;
  totalRows: number;
  createdAt: Date;
  summary: FourBucketSummary;
  ruleGaps: RuleGap[];
}

const SAMPLE_LIMIT = 25;

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
    include: { rowResults: true },
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

  return {
    importRunId: run.id,
    validationId: run.validationId,
    shopDomain: run.shopDomain,
    status: run.status,
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
