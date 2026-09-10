import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

const HTML_REGEX = /<[a-zA-Z\/!]/;

// Note is NOT checked: Shopify imported "<p>hello</p>" as a note in the 2026-09-10
// probe, while it rejected HTML in First Name and Company ("cannot contain HTML tags").
const CHECKED_FIELDS = [
  'First Name',
  'Last Name',
  'Default Address Address1',
  'Default Address Address2',
  'Default Address City',
  'Default Address Company',
];

export class HtmlInjectionRule implements CustomerValidationRule {
  name = 'HtmlInjectionRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      for (const field of CHECKED_FIELDS) {
        const value = row.normalized[field] ?? '';
        if (value && HTML_REGEX.test(value)) {
          issues.push({
            rowNumber: row.rowNumber,
            column: field,
            severity: 'Error',
            issueType: 'HtmlInjection',
            currentValue: row.original[field] ?? '',
            message: `"${field}" contains HTML tags, which Shopify rejects on import.`,
            suggestedFix: 'Remove all HTML tags from this field.',
          });
        }
      }
    }

    return issues;
  }
}
