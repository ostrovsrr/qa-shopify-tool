import { ProductGroup, ProductValidationIssue, ProductValidationRule } from '../../types';
import { productOptionNames, variantOptionValues, variantRowIndexes } from '../../services/productVariants';

// Shopify rejects a product whose variants repeat an option-value combination:
// "The variant 'Default Title' already exists." Most often several rows of one
// Handle carry a SKU or price but no option values, so every one of them becomes
// the single "Default Title" variant (63 products in one real migration file).
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
        // A blank value is MissingOptionValueRule's finding, not a duplicate.
        if (values.some((v) => v === '')) continue;
        const key = JSON.stringify(values);
        const label = values.join(' / ');
        const firstRow = firstRowFor.get(key);
        if (firstRow === undefined) {
          firstRowFor.set(key, group.rows[i].rowNumber);
          continue;
        }
        issues.push({
          rowNumber: group.rows[i].rowNumber,
          handle: group.handle,
          column: optionNames.length ? optionNames.map((n, j) => `Option${j + 1} Value (${n})`).join(', ') : 'Option1 Value',
          severity: 'Error',
          issueType: 'DuplicateVariant',
          currentValue: label,
          message: optionNames.length
            ? `Variant "${label}" repeats row ${firstRow} of product "${group.handle}". Shopify rejects the whole product.`
            : `Product "${group.handle}" has no options, so every variant row is "Default Title" and this row repeats row ${firstRow}. Shopify rejects the whole product.`,
          suggestedFix: optionNames.length
            ? 'Give each variant row a different option value, or remove the duplicate row.'
            : 'Add Option1 Name/Value to tell the variants apart, move this row to its own Handle, or remove its SKU and price if it only adds an image.',
        });
      }
    }

    return issues;
  }
}
