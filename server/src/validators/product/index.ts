import { ProductGroup, ProductValidationIssue, ProductValidationRule } from '../../types';
import { DuplicateVariantRule } from './duplicateVariant.rule';
import { GiftCardRule } from './giftCard.rule';
import { MoneyRule } from './money.rule';
import { VariantFieldsRule } from './variantFields.rule';
import { OptionsRule } from './options.rule';
import { ProductFieldsRule } from './productFields.rule';
import { ImageUrlRule } from './imageUrl.rule';
import { FILE_BLOCKING_ISSUE_TYPES } from './issue';

export { FILE_BLOCKING_ISSUE_TYPES };

// File-level checks only: each predicts, from the CSV alone, a rejection by
// Shopify's admin CSV import, pinned to an observed verdict (see
// docs/products/rejection-probe-results.md). A file with no pre-check errors
// should import every product. Store-dependent outcomes (a metafield with no
// definition there is silently dropped, not rejected) are not errors.
export const productValidationRules: ProductValidationRule[] = [
  new MoneyRule(),
  new VariantFieldsRule(),
  new ProductFieldsRule(),
  new OptionsRule(),
  new DuplicateVariantRule(),
  new ImageUrlRule(),
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

