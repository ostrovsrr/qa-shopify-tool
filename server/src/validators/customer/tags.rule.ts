import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

export class TagsRule implements CustomerValidationRule {
  name = 'TagsRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const tags = row.normalized['Tags'] ?? '';
      if (!tags) continue;

      const originalTags = row.original['Tags'] ?? '';

      // Only Shopify's hard limits are checked. Tag hygiene — consecutive
      // commas, leading/trailing commas, blank tags, duplicates — imports fine,
      // so it is not flagged.
      const nonEmptyTags = tags.split(',').map((t) => t.trim()).filter(Boolean);

      if (nonEmptyTags.length > 250) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Tags',
          severity: 'Error',
          issueType: 'TooManyTags',
          currentValue: originalTags,
          message: `Tags field has ${nonEmptyTags.length} tags (maximum 250 allowed by Shopify).`,
          suggestedFix: 'Remove tags until there are 250 or fewer.',
        });
      }

      for (const tag of nonEmptyTags) {
        if (tag.length > 255) {
          issues.push({
            rowNumber: row.rowNumber,
            column: 'Tags',
            severity: 'Error',
            issueType: 'TagTooLong',
            currentValue: tag.length > 60 ? `${tag.substring(0, 60)}...` : tag,
            message: `Tag "${tag.length > 40 ? tag.substring(0, 40) + '...' : tag}" is ${tag.length} characters long (maximum 255).`,
            suggestedFix: 'Shorten the tag to 255 characters or fewer.',
          });
        }
      }
    }

    return issues;
  }
}
