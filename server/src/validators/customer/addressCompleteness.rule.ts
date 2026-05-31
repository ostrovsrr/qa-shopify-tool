import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

const NORTH_AMERICAN_COUNTRIES = new Set([
  'canada', 'ca', 'united states', 'us', 'usa', 'united states of america',
]);

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
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Default Address Country Code',
          severity: 'Warning',
          issueType: 'MissingCountry',
          currentValue: '',
          message: 'Address fields are present but Country Code is missing.',
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
    }

    return issues;
  }
}
