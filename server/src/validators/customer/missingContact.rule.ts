import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

export class MissingContactRule implements CustomerValidationRule {
  name = 'MissingContactRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const firstName = row.normalized['First Name'] ?? '';
      const lastName = row.normalized['Last Name'] ?? '';
      const email = row.normalized['Email'] ?? '';
      const phone = row.normalized['Phone'] ?? '';

      if (!firstName && !lastName && !email && !phone) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'First Name / Last Name / Email / Phone',
          severity: 'Error',
          issueType: 'MissingContact',
          currentValue: '',
          message: 'All identity fields are blank (First Name, Last Name, Email, Phone). At least one must be present.',
          suggestedFix: 'Add at least a First Name, Last Name, Email, or Phone.',
        });
      }
    }

    return issues;
  }
}
