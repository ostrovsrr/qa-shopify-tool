import prisma from '../db/prisma';
import { CustomerValidationIssue, Severity } from '../types';
import { coverageKey, VALIDATOR_COVERAGE } from '../services/importFeedback.service';

// Maps a Shopify CustomerInput field (the last segment of a userError `field`,
// e.g. ['input','email'] → "email", ['input','addresses','0','zip'] → "zip") back
// to the Shopify CSV column names used in column mapping. Lets the report show
// the actual offending input value next to each Shopify rejection.
const GRAPHQL_FIELD_TO_SHOPIFY_COLUMN: Record<string, string> = {
  email: 'Email',
  phone: 'Phone',
  firstName: 'First Name',
  lastName: 'Last Name',
  note: 'Note',
  taxExempt: 'Tax Exempt',
  tags: 'Tags',
  address1: 'Default Address Address1',
  address2: 'Default Address Address2',
  city: 'Default Address City',
  company: 'Default Address Company',
  provinceCode: 'Default Address Province Code',
  countryCode: 'Default Address Country Code',
  zip: 'Default Address Zip',
};

interface ReportRowResult {
  rowNumber: number;
  accepted: boolean;
  shopifyCustomerId: string | null;
  shopifyCode: string | null;
  shopifyField: string | null;
  message: string | null;
  wasFlaggedByValidator: boolean;
}

interface OriginalRow {
  rowNumber: number;
  data: unknown;
}

// How many sample rows to list per group/section before summarizing.
const SAMPLE_LIMIT = 20;

function groupIssuesByRow(
  issues: CustomerValidationIssue[],
): Map<number, CustomerValidationIssue[]> {
  const map = new Map<number, CustomerValidationIssue[]>();
  for (const issue of issues) {
    if (!map.has(issue.rowNumber)) map.set(issue.rowNumber, []);
    map.get(issue.rowNumber)!.push(issue);
  }
  return map;
}

// Markdown table cells can't contain raw pipes/newlines — escape and clamp.
function cell(value: string | null | undefined): string {
  const v = (value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  return v.length > 160 ? `${v.slice(0, 157)}…` : v || '—';
}

export async function generateValidatorFeedbackMarkdown(
  importRunId: string,
): Promise<string | null> {
  const importRun = await prisma.importRun.findUnique({
    where: { id: importRunId },
    include: {
      rowResults: { orderBy: { rowNumber: 'asc' } },
      validationRun: {
        include: {
          issues: { orderBy: { rowNumber: 'asc' } },
          originalRows: { orderBy: { rowNumber: 'asc' } },
        },
      },
    },
  });

  if (!importRun) return null;

  const id8 = importRun.id.slice(0, 8);
  const validationRun = importRun.validationRun as typeof importRun.validationRun & {
    columnMapping: unknown;
    originalRows: OriginalRow[];
  };

  // Not finished yet — degrade gracefully instead of emitting an empty report.
  const rowResults = importRun.rowResults as ReportRowResult[];
  if (rowResults.length === 0) {
    return [
      `# Validator feedback — import ${id8}`,
      '',
      `This import is **${importRun.status}** and has no per-row Shopify results yet.`,
      'Re-run this report once the import has COMPLETED.',
      '',
    ].join('\n');
  }

  const columnMapping =
    validationRun.columnMapping &&
    typeof validationRun.columnMapping === 'object' &&
    !Array.isArray(validationRun.columnMapping)
      ? (validationRun.columnMapping as Record<string, string>)
      : {};
  // Shopify column → source CSV column, so we can read the original value.
  const reverseMap: Record<string, string> = {};
  for (const [src, tgt] of Object.entries(columnMapping)) reverseMap[tgt] = src;

  const issues: CustomerValidationIssue[] = validationRun.issues.map((issue) => ({
    rowNumber: issue.rowNumber,
    column: issue.columnName,
    severity: issue.severity as Severity,
    issueType: issue.issueType,
    currentValue: issue.currentValue ?? '',
    message: issue.message,
    suggestedFix: issue.suggestedFix ?? '',
  }));
  const issuesByRow = groupIssuesByRow(issues);
  const originalByRow = new Map(
    validationRun.originalRows.map((r) => [r.rowNumber, r.data as Record<string, string>]),
  );

  // graphqlField → Shopify column → source column → original value for a row.
  const offendingValue = (rowNumber: number, shopifyField: string | null): string => {
    if (!shopifyField) return '(no field)';
    const shopifyCol = GRAPHQL_FIELD_TO_SHOPIFY_COLUMN[shopifyField];
    if (!shopifyCol) return '(value unavailable)';
    const srcCol = reverseMap[shopifyCol];
    if (!srcCol) return '(column not mapped)';
    return originalByRow.get(rowNumber)?.[srcCol] ?? '(empty)';
  };

  const accepted = rowResults.filter((r) => r.accepted).length;
  const rejected = rowResults.length - accepted;
  const missingRule = rowResults.filter((r) => !r.accepted && !r.wasFlaggedByValidator);
  const falsePositive = rowResults.filter((r) => r.accepted && r.wasFlaggedByValidator);
  const confirmedReject = rowResults.filter((r) => !r.accepted && r.wasFlaggedByValidator).length;
  const confirmedClean = rowResults.filter((r) => r.accepted && !r.wasFlaggedByValidator).length;

  const out: string[] = [];
  out.push(`# Validator feedback — import ${id8} (${importRun.shopDomain || 'unknown shop'})`);
  out.push('');
  out.push(
    `File **${validationRun.fileName}** · validation \`${importRun.validationId.slice(0, 8)}\` · ` +
      `${rowResults.length} rows imported · ${accepted} accepted / ${rejected} rejected.`,
  );
  out.push('');
  out.push(
    `Buckets: **${missingRule.length} missing-rule** · ${falsePositive.length} false-positive · ` +
      `${confirmedReject} confirmed-reject · ${confirmedClean} confirmed-clean.`,
  );
  out.push('');

  // ── Section 1: missing rules (highest value) ───────────────────────────────
  out.push('## 1. Missing rules — Shopify rejected, our validator did NOT flag');
  out.push('');
  if (missingRule.length === 0) {
    out.push('_None — every Shopify rejection was already flagged by a validator._');
    out.push('');
  } else {
    const groups = new Map<
      string,
      { field: string | null; code: string | null; rows: ReportRowResult[] }
    >();
    for (const r of missingRule) {
      const key = `${r.shopifyField ?? ''}|${r.shopifyCode ?? ''}`;
      if (!groups.has(key)) {
        groups.set(key, { field: r.shopifyField, code: r.shopifyCode, rows: [] });
      }
      groups.get(key)!.rows.push(r);
    }
    const sorted = [...groups.values()].sort((a, b) => b.rows.length - a.rows.length);

    for (const g of sorted) {
      const validator = VALIDATOR_COVERAGE[coverageKey(g.field, g.code)] ?? null;
      const verdict = validator
        ? `**${validator}** exists but missed these rows → rule bug/gap to fix`
        : '**No validator** covers this → candidate for a NEW rule';
      out.push(
        `### \`${g.field ?? '(none)'}\` · \`${g.code ?? '(none)'}\` — ${g.rows.length} row(s)`,
      );
      out.push('');
      out.push(`- ${verdict}`);
      out.push(`- Shopify message: "${cell(g.rows[0].message)}"`);
      out.push('');
      out.push('| Row | Offending value | Shopify message |');
      out.push('| --- | --- | --- |');
      for (const r of g.rows.slice(0, SAMPLE_LIMIT)) {
        out.push(
          `| ${r.rowNumber} | ${cell(offendingValue(r.rowNumber, r.shopifyField))} | ${cell(r.message)} |`,
        );
      }
      if (g.rows.length > SAMPLE_LIMIT) {
        out.push(`| … | _${g.rows.length - SAMPLE_LIMIT} more_ | |`);
      }
      out.push('');
    }
  }

  // ── Section 2: false positives (over-strict) ───────────────────────────────
  out.push('## 2. False positives — we flagged, Shopify accepted (over-strict)');
  out.push('');
  if (falsePositive.length === 0) {
    out.push('_None — nothing we flagged was accepted by Shopify._');
    out.push('');
  } else {
    out.push('| Row | Our issue type(s) | Our message | Field | Value |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const r of falsePositive.slice(0, SAMPLE_LIMIT)) {
      const rowIssues = issuesByRow.get(r.rowNumber) ?? [];
      const types = [...new Set(rowIssues.map((i) => i.issueType))].join(', ');
      const messages = rowIssues.map((i) => i.message).join(' | ');
      const column = rowIssues[0]?.column ?? null;
      const value = rowIssues[0]?.currentValue ?? '';
      out.push(
        `| ${r.rowNumber} | ${cell(types)} | ${cell(messages)} | ${cell(column)} | ${cell(value)} |`,
      );
    }
    if (falsePositive.length > SAMPLE_LIMIT) {
      out.push(`| … | _${falsePositive.length - SAMPLE_LIMIT} more_ | | | |`);
    }
    out.push('');
  }

  // ── Section 3: confirmed (context) ─────────────────────────────────────────
  out.push('## 3. Confirmed (context)');
  out.push('');
  out.push(`- Confirmed rejects (we flagged, Shopify rejected): **${confirmedReject}**`);
  out.push(`- Confirmed clean (we passed, Shopify accepted): **${confirmedClean}**`);
  out.push('');

  // ── Footer ─────────────────────────────────────────────────────────────────
  out.push('## How to use this');
  out.push('');
  out.push(
    'Paste this into Claude Code. Ask it to fix or add the customer validators in ' +
      '`server/src/validators/customer/` so that section 1 (missing rules) is covered and ' +
      'section 2 (false positives) is relaxed. Section 1 groups are the priority: a named ' +
      'validator means the existing rule has a gap; "No validator" means a new rule is needed.',
  );
  out.push('');

  return out.join('\n');
}
