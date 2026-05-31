import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

const IMPORTANT_FIELDS = [
  'First Name', 'Last Name', 'Email', 'Phone',
  'Default Address Address1', 'Default Address Address2', 'Default Address City',
  'Default Address Province Code', 'Default Address Country Code',
  'Default Address Zip', 'Default Address Company', 'Default Address Phone',
];

export class WhitespaceRule implements CustomerValidationRule {
  name = 'WhitespaceRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      for (const field of IMPORTANT_FIELDS) {
        const original = row.original[field] ?? '';
        if (original && original !== original.trim()) {
          issues.push({
            rowNumber: row.rowNumber,
            column: field,
            severity: 'Warning',
            issueType: 'LeadingTrailingWhitespace',
            currentValue: original,
            message: `"${field}" has leading or trailing whitespace.`,
            suggestedFix: `Trim the value to: "${original.trim()}"`,
          });
        }
      }
    }

    return issues;
  }
}
