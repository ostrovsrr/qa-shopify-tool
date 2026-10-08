import type { ValidationResult } from '../types';

/**
 * How many rows the import actually sends to Shopify: the template dataset, after
 * merged duplicates and blank lines are removed — which is also what the server
 * splits across stores in a parallel import. Not result.totalRows, the raw file.
 *
 * summary.removed is exactly rawRows − templateRows (the summary invariant). Runs
 * validated before the summary existed carry no summary; for those, a fresh
 * validate still lists the dropped blank lines, and otherwise the raw count is
 * the best we know.
 */
export function rowsSent(result: ValidationResult): number {
  if (result.summary) return Math.max(0, result.totalRows - result.summary.removed);
  return Math.max(0, result.totalRows - (result.droppedBlankRows?.length ?? 0));
}
