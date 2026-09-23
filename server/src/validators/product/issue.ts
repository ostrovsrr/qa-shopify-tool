import { ProductCsvRow, ProductGroup, ProductValidationIssue } from '../../types';

// Issue types for which Shopify's admin import refuses the WHOLE file at upload,
// before any product is tried (observed 2026-09-22). Every other issue fails only
// its own product. The tool's own import does NOT refuse the file: it imports
// the rest and reports these products as rejected, so the whole list of
// problems shows up in one pass. The pre-check says the real import would not.
export const FILE_BLOCKING_ISSUE_TYPES = new Set(['UnreadableMoney', 'BlankInventoryPolicy']);

export const WHOLE_PRODUCT = 'Shopify rejects the whole product';
export const WHOLE_FILE =
  "Shopify's CSV import refuses the WHOLE FILE at upload for this (nothing is imported until it is fixed)";

/** One pre-check issue on a CSV row. `shopifySays` is the admin import's own
 *  wording, quoted so the report reads like the email Shopify sends. */
export function productIssue(
  group: ProductGroup,
  row: ProductCsvRow,
  f: {
    column: string;
    issueType: string;
    currentValue: string;
    message: string;
    shopifySays: string;
    suggestedFix: string;
  },
): ProductValidationIssue {
  const consequence = FILE_BLOCKING_ISSUE_TYPES.has(f.issueType) ? WHOLE_FILE : WHOLE_PRODUCT;
  return {
    rowNumber: row.rowNumber,
    handle: group.handle,
    column: f.column,
    severity: 'Error',
    issueType: f.issueType,
    currentValue: f.currentValue,
    // Shopify's wording can itself open with a quote ('"abc" is not a valid
    // price'); wrapping that again read as ""abc" is not a valid price".
    message: `${f.message} ${consequence}: ${f.shopifySays.startsWith('"') ? f.shopifySays : `"${f.shopifySays}"`}`,
    suggestedFix: f.suggestedFix,
  };
}

/** The raw cell, as the merchant typed it (for Current Value). */
export function rawCell(row: ProductCsvRow, column: string): string {
  return row.original[column] ?? '';
}
