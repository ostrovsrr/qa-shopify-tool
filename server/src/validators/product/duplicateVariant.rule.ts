import { ProductGroup, ProductValidationIssue, ProductValidationRule } from '../../types';
import { OPTION_VALUE_COLS, productOptionNames, variantOptionValues, variantRowIndexes } from '../../services/productVariants';
import { col } from '../../services/productCsvParser';
import { productIssue } from './issue';

// Shopify rejects a product whose variants repeat an option-value combination:
// "The variant 'Default Title' already exists." Most often several rows of one
// Handle carry a SKU or price but no option values, so every one of them becomes
// the single "Default Title" variant (63 products in one real migration file).
// A blank option value counts as "Default Title" too: the admin import fills it
// in rather than rejecting it, so two such rows collide.
export class DuplicateVariantRule implements ProductValidationRule {
  name = 'DuplicateVariantRule';

  validate(groups: ProductGroup[]): ProductValidationIssue[] {
    const issues: ProductValidationIssue[] = [];

    for (const group of groups) {
      const rows = group.rows.map((r) => r.normalized);
      const optionNames = productOptionNames(rows[0] ?? {});
      const firstRowFor = new Map<string, number>();

      for (const i of variantRowIndexes(rows)) {
        const values = variantOptionValues(rows[i], optionNames);
        const key = JSON.stringify(values);
        const label = values.join(' / ');
        const firstRow = firstRowFor.get(key);
        if (firstRow === undefined) {
          firstRowFor.set(key, group.rows[i].rowNumber);
          continue;
        }
        const blanks = optionNames.filter((_, j) => col(rows[i], OPTION_VALUE_COLS[j]) === '');
        issues.push(productIssue(group, group.rows[i], {
          column: optionNames.length ? optionNames.map((n, j) => `Option${j + 1} Value (${n})`).join(', ') : 'Option1 Value',
          issueType: 'DuplicateVariant',
          currentValue: label,
          message: optionNames.length
            ? `Variant "${label}" repeats row ${firstRow} of product "${group.handle}".` +
              (blanks.length ? ` A blank option value imports as "Default Title".` : '')
            : `Product "${group.handle}" has no options, so every variant row is "Default Title" and this row repeats row ${firstRow}.`,
          shopifySays: `The variant '${label}' already exists.`,
          suggestedFix: optionNames.length
            ? 'Give each variant row a different option value, or remove the duplicate row.'
            : 'Add Option1 Name/Value to tell the variants apart, move this row to its own Handle, or remove its SKU and price if it only adds an image.',
        }));
      }
    }

    return issues;
  }
}
