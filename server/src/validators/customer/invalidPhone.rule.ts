import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

// Allowed characters in a phone number
const SAFE_PHONE_REGEX = /^[0-9\s\-\(\)\+\.]+$/;

export class InvalidPhoneRule implements CustomerValidationRule {
  name = 'InvalidPhoneRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const phone = row.normalized['Phone'] ?? '';
      if (!phone) continue;

      const digits = phone.replace(/\D/g, '');

      if (digits.length < 7) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Phone',
          severity: 'Error',
          issueType: 'InvalidPhone',
          currentValue: row.original['Phone'] ?? '',
          message: `Phone number "${phone}" has too few digits (${digits.length} found, minimum 7 required).`,
          suggestedFix: 'Provide a valid phone number with at least 7 digits.',
        });
      } else if (!SAFE_PHONE_REGEX.test(phone)) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Phone',
          severity: 'Warning',
          issueType: 'SuspiciousPhoneCharacters',
          currentValue: row.original['Phone'] ?? '',
          message: `Phone number "${phone}" contains unexpected characters.`,
          suggestedFix: 'Use only digits, spaces, hyphens, parentheses, periods, and the + symbol.',
        });
      }
    }

    return issues;
  }
}
