import { canonicalPhone } from '../utils/normalize';

/** One Shopify Template row: the mapped (Shopify-column-keyed) record plus the
 *  CSV rows that were merged into it. */
export interface TemplateRow {
  rowNumber: number;
  record: Record<string, string>;
  mergedFrom: number[];
}

// Consent/privilege fields must never be escalated by a merge: the result is
// TRUE only if every row that specified the field agrees it's TRUE.
const NEVER_ESCALATE_FIELDS = ['Accepts Email Marketing', 'Accepts SMS Marketing', 'Tax Exempt'];

const TRUTHY = new Set(['true', 'yes', 'y', '1', 't']);

const NOTE_SEPARATOR = ' | ';

/** Normalized "First Last" for match comparison; '' when both names are empty
 *  (empty names never match — that's placeholder-email territory). */
function normalizedName(record: Record<string, string>): string {
  return `${record['First Name'] ?? ''} ${record['Last Name'] ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function filledCount(record: Record<string, string>): number {
  return Object.values(record).filter((v) => (v ?? '').trim() !== '').length;
}

/** Case-insensitive union of comma-separated tag lists, first occurrence wins. */
function unionTags(values: string[]): string {
  const seen: string[] = [];
  for (const value of values) {
    for (const tag of value.split(',').map((t) => t.trim()).filter(Boolean)) {
      if (!seen.some((s) => s.toLowerCase() === tag.toLowerCase())) seen.push(tag);
    }
  }
  return seen.join(',');
}

function mergeInto(keeper: TemplateRow, others: TemplateRow[]): TemplateRow {
  const all = [keeper, ...others];
  const record = { ...keeper.record };

  const fields = new Set<string>();
  for (const row of all) for (const key of Object.keys(row.record)) fields.add(key);

  for (const field of fields) {
    const nonEmpty = all
      .map((row) => (row.record[field] ?? '').trim())
      .filter((value) => value !== '');
    if (nonEmpty.length === 0) continue;

    if (field === 'Tags') {
      record[field] = unionTags(nonEmpty);
    } else if (field === 'Note') {
      record[field] = [...new Set(nonEmpty)].join(NOTE_SEPARATOR);
    } else if (NEVER_ESCALATE_FIELDS.includes(field)) {
      record[field] = nonEmpty.every((v) => TRUTHY.has(v.toLowerCase()))
        ? nonEmpty[0]
        : 'FALSE';
    } else if ((record[field] ?? '').trim() === '') {
      // Keeper's non-empty value wins; empty fields fill from the merged rows
      // in row order
      record[field] = nonEmpty[0];
    }
  }

  return {
    rowNumber: keeper.rowNumber,
    record,
    mergedFrom: [
      ...keeper.mergedFrom,
      ...others.flatMap((o) => [o.rowNumber, ...o.mergedFrom]),
    ].sort((a, b) => a - b),
  };
}

/** Merge, within each group of rows sharing the same normalized `field` value,
 *  the subsets whose (non-empty) names also match. The most-filled row of a
 *  subset is the keeper; ties go to the earliest row. */
function mergePass(
  rows: TemplateRow[],
  field: string,
  normalize: (value: string) => string,
): TemplateRow[] {
  const byValue = new Map<string, TemplateRow[]>();
  for (const row of rows) {
    const key = normalize(row.record[field] ?? '');
    if (!key) continue;
    if (!byValue.has(key)) byValue.set(key, []);
    byValue.get(key)!.push(row);
  }

  const absorbed = new Set<number>();
  const replacement = new Map<number, TemplateRow>();
  for (const group of byValue.values()) {
    if (group.length < 2) continue;
    const byName = new Map<string, TemplateRow[]>();
    for (const row of group) {
      const name = normalizedName(row.record);
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push(row);
    }
    for (const bucket of byName.values()) {
      if (bucket.length < 2) continue;
      let keeper = bucket[0];
      for (const row of bucket) {
        if (filledCount(row.record) > filledCount(keeper.record)) keeper = row;
      }
      const others = bucket.filter((row) => row !== keeper);
      replacement.set(keeper.rowNumber, mergeInto(keeper, others));
      for (const other of others) absorbed.add(other.rowNumber);
    }
  }

  return rows
    .filter((row) => !absorbed.has(row.rowNumber))
    .map((row) => replacement.get(row.rowNumber) ?? row);
}

/**
 * Merge duplicate rows that are the same person: rows sharing an email (or,
 * in a second pass, a phone) whose names also match exactly (normalized,
 * non-empty). Running the phone pass on the email pass's output also collapses
 * simple transitive chains (A=B by email, B=C by phone).
 */
export function mergeMatchingDuplicateRows(rows: TemplateRow[]): TemplateRow[] {
  const afterEmail = mergePass(rows, 'Email', (v) => v.trim().toLowerCase());
  return mergePass(afterEmail, 'Phone', canonicalPhone);
}
