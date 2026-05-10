import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

export class MissingContactRule implements CustomerValidationRule {
  name = 'MissingContactRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const email = row.normalized['Email'] ?? '';
      const phone = row.normalized['Phone'] ?? '';

      if (!email && !phone) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Email / Phone',
          severity: 'Error',
          issueType: 'MissingContact',
          currentValue: '',
          message: 'Both Email and Phone are missing. At least one contact method is required.',
          suggestedFix: 'Add a valid email address or phone number.',
        });
      }
    }

    return issues;
  }
}
