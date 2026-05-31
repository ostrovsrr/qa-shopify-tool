import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

// A1A 1A1 format (with optional space)
const CA_POSTAL_REGEX = /^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/;
// 5 digits or ZIP+4
const US_ZIP_REGEX = /^\d{5}(-\d{4})?$/;

export class PostalCodeRule implements CustomerValidationRule {
  name = 'PostalCodeRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const country = (row.normalized['Default Address Country Code'] ?? '').toLowerCase();
      const zip = row.normalized['Default Address Zip'] ?? '';

      if (!zip) continue;

      if (country === 'canada' || country === 'ca') {
        if (!CA_POSTAL_REGEX.test(zip)) {
          issues.push({
            rowNumber: row.rowNumber,
            column: 'Default Address Zip',
            severity: 'Warning',
            issueType: 'InvalidCanadianPostalCode',
            currentValue: row.original['Default Address Zip'] ?? '',
            message: `"${zip}" does not look like a Canadian postal code.`,
            suggestedFix: 'Canadian postal codes use the format A1A 1A1 (e.g., M5V 3L9).',
          });
        }
      } else if (country === 'united states' || country === 'us' || country === 'usa') {
        if (!US_ZIP_REGEX.test(zip)) {
          issues.push({
            rowNumber: row.rowNumber,
            column: 'Default Address Zip',
            severity: 'Warning',
            issueType: 'InvalidUSZipCode',
            currentValue: row.original['Default Address Zip'] ?? '',
            message: `"${zip}" does not look like a US ZIP code.`,
            suggestedFix: 'US ZIP codes should be 5 digits or 5+4 format (e.g., 12345 or 12345-6789).',
          });
        }
      }
    }

    return issues;
  }
}
