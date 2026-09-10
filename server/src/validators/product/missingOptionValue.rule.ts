import { ProductGroup, ProductValidationIssue, ProductValidationRule } from '../../types';
import { col } from '../../services/productCsvParser';
import {
  OPTION_NAME_COLS,
  productOptionNames,
  variantOptionValues,
  variantRowIndexes,
} from '../../services/productVariants';

// A product's options are declared on its first row. Every variant row needs a value
// for each of them, or Shopify rejects the product: "The name provided is not
// valid." The real cause seen (10 products in one migration file) was a stray row declaring a
// different option set, e.g. Option1 Name "Variant" on a Color/Size product.
export class MissingOptionValueRule implements ProductValidationRule {
  name = 'MissingOptionValueRule';

  validate(groups: ProductGroup[]): ProductValidationIssue[] {
    const issues: ProductValidationIssue[] = [];

    for (const group of groups) {
      const rows = group.rows.map((r) => r.normalized);
      const optionNames = productOptionNames(rows[0] ?? {});
      if (optionNames.length === 0) continue;

      for (const i of variantRowIndexes(rows)) {
        const values = variantOptionValues(rows[i], optionNames);
        const missing = optionNames.filter((_, j) => values[j] === '');
        if (missing.length === 0) continue;

        const ownNames = OPTION_NAME_COLS.map((c) => col(rows[i], c)).filter(Boolean);
        const declaresOther = ownNames.length > 0 && ownNames.join('|') !== optionNames.join('|');
        issues.push({
          rowNumber: group.rows[i].rowNumber,
          handle: group.handle,
          column: missing.map((n) => `Option${optionNames.indexOf(n) + 1} Value (${n})`).join(', '),
          severity: 'Error',
          issueType: 'MissingOptionValue',
          currentValue: values.join(' / '),
          message:
            `Variant row of product "${group.handle}" has no value for ${missing.map((n) => `"${n}"`).join(', ')}. Shopify rejects the whole product.` +
            (declaresOther
              ? ` This row declares options ${ownNames.map((n) => `"${n}"`).join(', ')}, but the product's are ${optionNames.map((n) => `"${n}"`).join(', ')} (from its first row).`
              : ''),
          suggestedFix: `Fill in ${missing.join(', ')} for this variant, or remove the row if it is not a real variant.`,
        });
      }
    }

    return issues;
  }
}
