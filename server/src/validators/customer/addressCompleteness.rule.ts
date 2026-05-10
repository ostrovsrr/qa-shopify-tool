import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

const NORTH_AMERICAN_COUNTRIES = new Set([
  'canada', 'ca', 'united states', 'us', 'usa', 'united states of america',
]);

const ADDRESS_FIELDS = ['Address1', 'Address2', 'City', 'Province', 'Province Code', 'Country', 'Zip'];

export class AddressCompletenessRule implements CustomerValidationRule {
  name = 'AddressCompletenessRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const hasAnyAddress = ADDRESS_FIELDS.some((f) => row.normalized[f]);
      if (!hasAnyAddress) continue;

      const country = row.normalized['Country'] ?? '';
      const city = row.normalized['City'] ?? '';
      const province = row.normalized['Province'] || row.normalized['Province Code'] || '';

      if (!country) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Country',
          severity: 'Warning',
          issueType: 'MissingCountry',
          currentValue: '',
          message: 'Address fields are present but Country is missing.',
          suggestedFix: 'Add the country for this address.',
        });
      }

      if (!city) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'City',
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
          column: 'Province',
          severity: 'Warning',
          issueType: 'MissingProvince',
          currentValue: '',
          message: `Province/State is missing for "${country}".`,
          suggestedFix: 'Add the province or state for this North American address.',
        });
      }
    }

    return issues;
  }
}
