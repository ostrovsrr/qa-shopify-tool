import { ProductGroup, ProductValidationIssue, ProductValidationRule } from '../../types';
import { DuplicateVariantRule } from './duplicateVariant.rule';
import { MissingOptionValueRule } from './missingOptionValue.rule';
import { GiftCardRule } from './giftCard.rule';

// File-level checks only: each predicts a rejection from the CSV alone. Rejections
// that depend on the target store (a metafield with no definition there) are left
// to the import, which reports them.
export const productValidationRules: ProductValidationRule[] = [
  new DuplicateVariantRule(),
  new MissingOptionValueRule(),
  new GiftCardRule(),
];

export function runProductValidation(groups: ProductGroup[]): ProductValidationIssue[] {
  const issues: ProductValidationIssue[] = [];
  for (const rule of productValidationRules) {
    // Per-issue push, not push(...arr): see validateCustomerCsv.
    for (const issue of rule.validate(groups)) issues.push(issue);
  }
  return issues.sort((a, b) => a.rowNumber - b.rowNumber);
}
