import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

const NORTH_AMERICAN_COUNTRIES = new Set([
  'canada', 'ca', 'united states', 'us', 'usa', 'united states of america',
]);

const ADDRESS_PHONE_REGEX = /^[0-9\s\-\(\)\+\.]+$/;

const ADDRESS_FIELDS = [
  'Default Address Address1',
  'Default Address Address2',
  'Default Address City',
  'Default Address Province Code',
  'Default Address Country Code',
  'Default Address Zip',
  'Default Address Company',
  'Default Address Phone',
];

export class AddressCompletenessRule implements CustomerValidationRule {
  name = 'AddressCompletenessRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const hasAnyAddress = ADDRESS_FIELDS.some((f) => row.normalized[f]);
      if (!hasAnyAddress) continue;

      const country = row.normalized['Default Address Country Code'] ?? '';
      const city = row.normalized['Default Address City'] ?? '';
      const province = row.normalized['Default Address Province Code'] || '';

      if (!country) {
        const hasProvince = !!row.normalized['Default Address Province Code'];
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Default Address Country Code',
          severity: hasProvince ? 'Error' : 'Warning',
          issueType: 'MissingCountry',
          currentValue: '',
          message: hasProvince
            ? 'Province Code is present but Country Code is missing.'
            : 'Address fields are present but Country Code is missing.',
          suggestedFix: 'Add the country code for this address (e.g. CA, US).',
        });
      }

      if (!city) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Default Address City',
          severity: 'Warning',
          issueType: 'MissingCity',
          currentValue: '',
          message: 'Address fields are present but City is missing.',
          suggestedFix: 'Add the city for this address.',
        });
      }

      if (country && NORTH_AMERICAN_COUNTRIES.has(country.toLowerCase()) && !province) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Default Address Province Code',
          severity: 'Warning',
          issueType: 'MissingProvince',
          currentValue: '',
          message: `Province/State code is missing for "${country}".`,
          suggestedFix: 'Add the province or state code for this North American address (e.g. ON, CA).',
        });
      }

      const address1 = row.normalized['Default Address Address1'] ?? '';
      const OTHER_ADDRESS_FIELDS = [
        'Default Address Address2',
        'Default Address City',
        'Default Address Province Code',
        'Default Address Country Code',
        'Default Address Zip',
        'Default Address Company',
        'Default Address Phone',
      ];
      if (!address1 && OTHER_ADDRESS_FIELDS.some((f) => row.normalized[f])) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Default Address Address1',
          severity: 'Warning',
          issueType: 'MissingAddress1',
          currentValue: '',
          message: 'Other address fields are present but Address1 (street) is missing.',
          suggestedFix: 'Add the street address to Default Address Address1.',
        });
      }

      const addressPhone = row.normalized['Default Address Phone'] ?? '';
      if (addressPhone) {
        if (!ADDRESS_PHONE_REGEX.test(addressPhone)) {
          issues.push({
            rowNumber: row.rowNumber,
            column: 'Default Address Phone',
            severity: 'Warning',
            issueType: 'InvalidAddressPhone',
            currentValue: row.original['Default Address Phone'] ?? '',
            message: `Address phone "${addressPhone}" contains unexpected characters.`,
            suggestedFix: 'Use only digits, spaces, hyphens, parentheses, periods, and the + symbol.',
          });
        } else {
          const digits = addressPhone.replace(/\D/g, '');
          if (digits.length < 10) {
            issues.push({
              rowNumber: row.rowNumber,
              column: 'Default Address Phone',
              severity: 'Warning',
              issueType: 'InvalidAddressPhone',
              currentValue: row.original['Default Address Phone'] ?? '',
              message: `Address phone "${addressPhone}" has too few digits (${digits.length} found, minimum 10).`,
              suggestedFix: 'Add the area code and country code if missing.',
            });
          } else if (digits.length > 15) {
            issues.push({
              rowNumber: row.rowNumber,
              column: 'Default Address Phone',
              severity: 'Warning',
              issueType: 'InvalidAddressPhone',
              currentValue: row.original['Default Address Phone'] ?? '',
              message: `Address phone "${addressPhone}" has too many digits (${digits.length} found, maximum 15 per E.164).`,
              suggestedFix: 'Verify the phone number and remove extra digits.',
            });
          }
        }
      }
    }

    return issues;
  }
}
