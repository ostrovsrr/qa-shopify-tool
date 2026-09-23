import { ProductGroup, ProductValidationIssue, ProductValidationRule } from '../../types';
import { variantRowIndexes } from '../../services/productVariants';
import { parseMoney } from '../../services/productValues';
import { productIssue, rawCell } from './issue';

// The admin import reads the first number in a money cell, so "$10.00" or
// "10 USD" import fine. A cell with no number at all refuses the whole file at
// upload, with no row number: '"abc" is not a valid price' (Compare At Price
// uses the same "price" wording). A negative price fails its product.
const MONEY_COLUMNS: { column: string; noun: string }[] = [
  { column: 'Variant Price', noun: 'price' },
  { column: 'Variant Compare At Price', noun: 'price' },
  { column: 'Cost per item', noun: 'cost per item' },
];

export class MoneyRule implements ProductValidationRule {
  name = 'MoneyRule';

  validate(groups: ProductGroup[]): ProductValidationIssue[] {
    const issues: ProductValidationIssue[] = [];

    for (const group of groups) {
      // Every row: the upload check reads each cell, image-only rows included.
      for (const row of group.rows) {
        for (const { column, noun } of MONEY_COLUMNS) {
          const raw = rawCell(row, column);
          if (parseMoney(raw) !== 'invalid') continue;
          issues.push(productIssue(group, row, {
            column,
            issueType: 'UnreadableMoney',
            currentValue: raw,
            message: `${column} "${raw.trim()}" has no number in it.`,
            shopifySays: `"${raw.trim()}" is not a valid ${noun}`,
            suggestedFix: `Put a number in ${column} (for example 19.99), or leave it blank.`,
          }));
        }
      }

      const rows = group.rows.map((r) => r.normalized);
      for (const i of variantRowIndexes(rows)) {
        const row = group.rows[i];
        const price = parseMoney(rawCell(row, 'Variant Price'));
        if (typeof price !== 'number' || price >= 0) continue;
        issues.push(productIssue(group, row, {
          column: 'Variant Price',
          issueType: 'NegativePrice',
          currentValue: rawCell(row, 'Variant Price'),
          message: `Variant Price is negative.`,
          shopifySays: 'Price must be greater than or equal to 0',
          suggestedFix: 'Set a price of 0 or more.',
        }));
      }
    }

    return issues;
  }
}
