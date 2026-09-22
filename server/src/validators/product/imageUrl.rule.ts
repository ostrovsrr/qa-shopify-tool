import { ProductGroup, ProductValidationIssue, ProductValidationRule } from '../../types';
import { isValidImageUrl } from '../../services/productValues';
import { productIssue, rawCell } from './issue';

// An Image Src that is not a web address fails the product: "File URL is
// invalid". A valid address that can't be downloaded still imports (the image
// just shows as failed), so only the address itself is checked. Variant Image
// goes through the same file input, so it is held to the same rule.
const IMAGE_COLUMNS = ['Image Src', 'Variant Image'];

export class ImageUrlRule implements ProductValidationRule {
  name = 'ImageUrlRule';

  validate(groups: ProductGroup[]): ProductValidationIssue[] {
    const issues: ProductValidationIssue[] = [];

    for (const group of groups) {
      for (const row of group.rows) {
        for (const column of IMAGE_COLUMNS) {
          const raw = rawCell(row, column);
          if (raw.trim() === '' || isValidImageUrl(raw)) continue;
          issues.push(productIssue(group, row, {
            column,
            issueType: 'InvalidImageUrl',
            currentValue: raw,
            message: `${column} "${raw.trim()}" is not a web address.`,
            shopifySays: 'File URL is invalid',
            suggestedFix: 'Use the full image address, starting with https://, or leave it blank.',
          }));
        }
      }
    }

    return issues;
  }
}
