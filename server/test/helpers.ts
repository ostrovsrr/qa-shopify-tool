import { CustomerCsvRow } from '../src/types';
import { normalizeRecord } from '../src/utils/normalize';

/**
 * Build a single CustomerCsvRow the way the parser would: `normalized` is the
 * trimmed version of `original`. Pass the raw (untrimmed) field values so rules
 * that care about whitespace (WhitespaceRule) behave realistically.
 */
export function makeRow(
  rowNumber: number,
  fields: Record<string, string>,
): CustomerCsvRow {
  return {
    rowNumber,
    original: { ...fields },
    normalized: normalizeRecord(fields),
  };
}

/** Build a list of rows, numbering them from 2 (matching the parser: header is row 1). */
export function makeRows(records: Record<string, string>[]): CustomerCsvRow[] {
  return records.map((record, index) => makeRow(index + 2, record));
}

/** Count issues by issueType — handy for asserting on a whole rule run. */
export function countByType(
  issues: { issueType: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.issueType] = (counts[issue.issueType] ?? 0) + 1;
  }
  return counts;
}
