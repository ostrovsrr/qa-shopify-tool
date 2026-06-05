import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

const EMAIL_REGEX =
  /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export class InvalidEmailRule implements CustomerValidationRule {
  name = 'InvalidEmailRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const email = row.normalized['Email'] ?? '';
      if (email && !EMAIL_REGEX.test(email)) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Email',
          severity: 'Error',
          issueType: 'InvalidEmail',
          currentValue: row.original['Email'] ?? '',
          message: `"${email}" is not a valid email address.`,
          suggestedFix: 'Correct the email format, e.g. user@example.com.',
        });
      }
    }

    return issues;
  }
}