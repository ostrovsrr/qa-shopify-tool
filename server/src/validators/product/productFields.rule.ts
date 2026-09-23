import { ProductCsvRow, ProductGroup, ProductValidationIssue, ProductValidationRule } from '../../types';
import { col } from '../../services/productCsvParser';
import { variantRowIndexes } from '../../services/productVariants';
import { MAX_TEXT_LENGTH, parseStatus, splitTags } from '../../services/productValues';
import { productIssue, rawCell } from './issue';

// Product and variant text the admin import rejects (observed 2026-09-22), with
// Shopify's wording for each:
//   • Title blank on the product's first row: "Title must be specified"
//   • Title / Vendor / Type / SKU / Barcode over 255 characters
//   • any single tag over 255 characters: "Product tags is invalid"
//   • Status other than active / draft / archived / unlisted
const PRODUCT_TEXT: { columns: string[]; label: string }[] = [
  { columns: ['Title'], label: 'Title' },
  { columns: ['Vendor'], label: 'Vendor' },
  { columns: ['Type', 'Product Type'], label: 'Product type' },
];
const VARIANT_TEXT: { column: string; label: string }[] = [
  { column: 'Variant SKU', label: 'SKU' },
  { column: 'Variant Barcode', label: 'Barcode' },
];

export class ProductFieldsRule implements ProductValidationRule {
  name = 'ProductFieldsRule';

  validate(groups: ProductGroup[]): ProductValidationIssue[] {
    const issues: ProductValidationIssue[] = [];

    for (const group of groups) {
      const first = group.rows[0];
      if (!first) continue;
      const tooLong = (row: ProductCsvRow, column: string, label: string, value: string) =>
        productIssue(group, row, {
          column,
          issueType: 'FieldTooLong',
          currentValue: rawCell(row, column),
          message: `${column} is ${value.length} characters; the limit is ${MAX_TEXT_LENGTH}.`,
          shopifySays: `${label} is too long (maximum is ${MAX_TEXT_LENGTH} characters)`,
          suggestedFix: `Shorten ${column} to ${MAX_TEXT_LENGTH} characters or fewer.`,
        });

      if (col(first.normalized, 'Title') === '') {
        issues.push(productIssue(group, first, {
          column: 'Title',
          issueType: 'MissingTitle',
          currentValue: '',
          message: `Product "${group.handle}" has no Title on its first row.`,
          shopifySays: 'Title must be specified',
          suggestedFix: "Fill in the Title on the product's first row (the row where its Handle first appears).",
        }));
      }

      for (const { columns, label } of PRODUCT_TEXT) {
        const column = columns.find((c) => c in first.original) ?? columns[0];
        const value = col(first.normalized, column);
        if (value.length > MAX_TEXT_LENGTH) issues.push(tooLong(first, column, label, value));
      }

      const longTag = splitTags(col(first.normalized, 'Tags')).find((t) => t.length > MAX_TEXT_LENGTH);
      if (longTag) {
        issues.push(productIssue(group, first, {
          column: 'Tags',
          issueType: 'TagTooLong',
          currentValue: rawCell(first, 'Tags'),
          message: `One tag is ${longTag.length} characters; each tag can be at most ${MAX_TEXT_LENGTH}.`,
          shopifySays: 'Product tags is invalid',
          suggestedFix: 'Shorten that tag, or check for a missing comma between two tags.',
        }));
      }

      const statusRaw = rawCell(first, 'Status');
      if (parseStatus(statusRaw) === 'invalid') {
        issues.push(productIssue(group, first, {
          column: 'Status',
          issueType: 'InvalidStatus',
          currentValue: statusRaw,
          message: `Status "${statusRaw.trim()}" is not active, draft, archived or unlisted.`,
          shopifySays: "Status isn't valid. Set the status as active, draft, or archived.",
          suggestedFix: 'Use active, draft or archived, or leave Status blank to use the Published column.',
        }));
      }

      const rows = group.rows.map((r) => r.normalized);
      for (const i of variantRowIndexes(rows)) {
        for (const { column, label } of VARIANT_TEXT) {
          const value = col(rows[i], column);
          if (value.length > MAX_TEXT_LENGTH) issues.push(tooLong(group.rows[i], column, label, value));
        }
      }
    }

    return issues;
  }
}
