import { ProductGroup, ProductValidationIssue, ProductValidationRule } from '../../types';
import { col } from '../../services/productCsvParser';
import { isTruthy } from '../../services/productVariants';
import { productIssue, rawCell } from './issue';

// Shopify's help center: "you can't create a gift card by importing a product CSV
// file. A gift card can only be created and activated in the Shopify admin." The
// import rejects it as GIFT_CARDS_NOT_ACTIVATED (seen once in a real migration file).
export class GiftCardRule implements ProductValidationRule {
  name = 'GiftCardRule';

  validate(groups: ProductGroup[]): ProductValidationIssue[] {
    const issues: ProductValidationIssue[] = [];

    for (const group of groups) {
      const first = group.rows[0];
      if (!first) continue;
      const value = col(first.normalized, 'Gift Card');
      if (value === '' || !isTruthy(value)) continue;
      issues.push(productIssue(group, first, {
        column: 'Gift Card',
        issueType: 'GiftCardProduct',
        currentValue: rawCell(first, 'Gift Card') || value,
        message: `Product "${group.handle}" is a gift card, and Shopify does not create gift cards from a product CSV import.`,
        shopifySays: 'Gift card products can only be created after they have been activated',
        suggestedFix: 'Create the gift card in the Shopify admin and remove this product from the CSV, or set Gift Card to FALSE.',
      }));
    }

    return issues;
  }
}
