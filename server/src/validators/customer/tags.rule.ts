import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

export class TagsRule implements CustomerValidationRule {
  name = 'TagsRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const tags = row.normalized['Tags'] ?? '';
      if (!tags) continue;

      const originalTags = row.original['Tags'] ?? '';

      if (/,,/.test(tags)) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Tags',
          severity: 'Warning',
          issueType: 'DuplicateCommasInTags',
          currentValue: originalTags,
          message: 'Tags field contains consecutive commas (duplicate separators).',
          suggestedFix: 'Remove extra commas; each tag should be separated by a single comma.',
        });
      }

      if (tags.startsWith(',') || tags.endsWith(',')) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Tags',
          severity: 'Warning',
          issueType: 'TagsStartsOrEndsWithComma',
          currentValue: originalTags,
          message: 'Tags field starts or ends with a comma.',
          suggestedFix: 'Remove the leading or trailing comma from the Tags field.',
        });
      }

      const tagList = tags.split(',').map((t) => t.trim());
      const hasEmptyTag = tagList.some((t) => !t);

      if (hasEmptyTag) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Tags',
          severity: 'Warning',
          issueType: 'EmptyTagValues',
          currentValue: originalTags,
          message: 'Tags field contains empty tag values.',
          suggestedFix: 'Trim each tag and remove any that are blank.',
        });
      }

      const nonEmptyTags = tagList.filter(Boolean);
      const uniqueTags = new Set(nonEmptyTags.map((t) => t.toLowerCase()));

      if (uniqueTags.size < nonEmptyTags.length) {
        const cleaned = [...uniqueTags].join(', ');
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Tags',
          severity: 'Warning',
          issueType: 'DuplicateTags',
          currentValue: originalTags,
          message: 'Tags field contains duplicate tag values.',
          suggestedFix: `Remove duplicate tags. Suggested value: "${cleaned}"`,
        });
      }

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
