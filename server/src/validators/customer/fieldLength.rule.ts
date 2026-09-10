import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

// Shopify's length limits, each one hit in the 2026-09-10 probe with its own message
// ("First name is too long (maximum is 255 characters)" etc.). Counted in characters
// (code points), which is how Shopify counts. Email has its own check in
// InvalidEmailRule; tags in TagsRule.
const LIMITS: [field: string, max: number][] = [
  ['First Name', 255],
  ['Last Name', 255],
  ['Note', 5000],
  ['Default Address Company', 255],
  ['Default Address Address1', 255],
  ['Default Address Address2', 255],
  ['Default Address City', 255],
];

export class FieldLengthRule implements CustomerValidationRule {
  name = 'FieldLengthRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      for (const [field, max] of LIMITS) {
        const value = row.normalized[field] ?? '';
        const length = [...value].length;
        if (length <= max) continue;
        issues.push({
          rowNumber: row.rowNumber,
          column: field,
          severity: 'Error',
          issueType: 'FieldTooLong',
          currentValue: row.original[field] ?? '',
          message: `"${field}" is ${length} characters long; Shopify's maximum is ${max}.`,
          suggestedFix: field === 'Note'
            ? `Shorten the note to ${max} characters or fewer.`
            : `Shorten it to ${max} characters or fewer.`,
        });
      }
    }

    return issues;
  }
}
