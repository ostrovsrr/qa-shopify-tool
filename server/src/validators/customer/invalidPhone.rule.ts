import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

const SAFE_PHONE_REGEX = /^[0-9\s\-\(\)\+\.]+$/;
// Matches Excel scientific notation for large numbers, e.g. 1.23456E+11
const SCIENTIFIC_NOTATION_REGEX = /\d+\.?\d*[eE][+\-]?\d+/;

export class InvalidPhoneRule implements CustomerValidationRule {
  name = 'InvalidPhoneRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const phone = row.normalized['Phone'] ?? '';
      if (!phone) continue;

      if (SCIENTIFIC_NOTATION_REGEX.test(phone)) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Phone',
          severity: 'Error',
          issueType: 'InvalidPhone',
          currentValue: row.original['Phone'] ?? '',
          message: `Phone number "${phone}" appears to be in Excel scientific notation. The original digits were lost.`,
          suggestedFix: 'Re-export the CSV with the phone column formatted as Text to preserve all digits.',
        });
        continue;
      }

      if (!SAFE_PHONE_REGEX.test(phone)) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Phone',
          severity: 'Warning',
          issueType: 'SuspiciousPhoneCharacters',
          currentValue: row.original['Phone'] ?? '',
          message: `Phone number "${phone}" contains unexpected characters.`,
          suggestedFix: 'Use only digits, spaces, hyphens, parentheses, periods, and the + symbol.',
        });
        continue;
      }

      const digits = phone.replace(/\D/g, '');

      if (digits.length < 10) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Phone',
          severity: 'Error',
          issueType: 'InvalidPhone',
          currentValue: row.original['Phone'] ?? '',
          message: `Phone number "${phone}" has too few digits (${digits.length} found, 10–15 required). Shopify rejects local numbers without an area code.`,
          suggestedFix: 'Add the area code (and country code if outside the US/Canada), or leave the field blank.',
        });
      } else if (digits.length > 15) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Phone',
          severity: 'Error',
          issueType: 'InvalidPhone',
          currentValue: row.original['Phone'] ?? '',
          message: `Phone number "${phone}" has too many digits (${digits.length} found, maximum 15 per E.164).`,
          suggestedFix: 'Verify the phone number and remove extra digits, or leave the field blank.',
        });
      }
    }

    return issues;
  }
}
