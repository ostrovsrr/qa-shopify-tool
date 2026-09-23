import { ProductGroup, ProductValidationIssue, ProductValidationRule } from '../../types';
import { variantRowIndexes } from '../../services/productVariants';
import { parseGrams, parseInventoryPolicy } from '../../services/productValues';
import { productIssue, rawCell } from './issue';

// Variant columns the admin import validates on each variant row (image-only
// rows are not variants and are not checked):
//   • Variant Grams: needs a leading number, and not a negative one.
//   • Variant Inventory Policy: deny or continue, any case. A BLANK policy on a
//     variant row refuses the whole file at upload, but only when the column is
//     in the file at all; without the column every variant defaults to deny.
// (Weight Unit and Inventory Qty never fail a product: a bad unit is ignored and
// the quantity is read as a leading integer.)
export class VariantFieldsRule implements ProductValidationRule {
  name = 'VariantFieldsRule';

  validate(groups: ProductGroup[]): ProductValidationIssue[] {
    const issues: ProductValidationIssue[] = [];

    for (const group of groups) {
      const rows = group.rows.map((r) => r.normalized);
      for (const i of variantRowIndexes(rows)) {
        const row = group.rows[i];

        const gramsRaw = rawCell(row, 'Variant Grams');
        const grams = parseGrams(gramsRaw);
        if (grams === 'invalid') {
          issues.push(productIssue(group, row, {
            column: 'Variant Grams',
            issueType: 'InvalidWeight',
            currentValue: gramsRaw,
            message: `Variant Grams "${gramsRaw.trim()}" does not start with a number.`,
            shopifySays: "Weight isn't a number.",
            suggestedFix: 'Put the weight in grams as a number (for example 250), or leave it blank.',
          }));
        } else if (grams !== null && grams < 0) {
          issues.push(productIssue(group, row, {
            column: 'Variant Grams',
            issueType: 'NegativeWeight',
            currentValue: gramsRaw,
            message: 'Variant Grams is negative.',
            shopifySays: 'Weight must be greater than or equal to 0',
            suggestedFix: 'Set a weight of 0 or more.',
          }));
        }

        if (!('Variant Inventory Policy' in row.original)) continue;
        const policyRaw = rawCell(row, 'Variant Inventory Policy');
        const policy = parseInventoryPolicy(policyRaw);
        if (policy === 'blank') {
          issues.push(productIssue(group, row, {
            column: 'Variant Inventory Policy',
            issueType: 'BlankInventoryPolicy',
            currentValue: '',
            message: 'Variant Inventory Policy is blank on a variant row.',
            shopifySays: 'Inventory policy is not included in the list',
            suggestedFix: 'Fill in "deny" (stop selling when out of stock) or "continue" on every variant row.',
          }));
        } else if (policy === 'invalid') {
          issues.push(productIssue(group, row, {
            column: 'Variant Inventory Policy',
            issueType: 'InvalidInventoryPolicy',
            currentValue: policyRaw,
            message: `Variant Inventory Policy "${policyRaw.trim()}" is not deny or continue.`,
            shopifySays: 'Inventory policy is not included in the list',
            suggestedFix: 'Use "deny" (stop selling when out of stock) or "continue".',
          }));
        }
      }
    }

    return issues;
  }
}
