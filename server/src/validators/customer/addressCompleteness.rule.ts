import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

export class AddressCompletenessRule implements CustomerValidationRule {
  name = 'AddressCompletenessRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      // A province code with no country is the one address gap Shopify rejects
      // outright: it can't resolve the zone without knowing the country. Every
      // other completeness gap (missing city, missing Address1, missing province,
      // odd address phone) imports fine or fails at import, so it isn't checked.
      const hasProvince = !!row.normalized['Default Address Province Code'];
      const country = row.normalized['Default Address Country Code'] ?? '';

      if (hasProvince && !country) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Default Address Country Code',
          severity: 'Error',
          issueType: 'MissingCountry',
          currentValue: '',
          message: 'Province Code is present but Country Code is missing.',
          suggestedFix: 'Add the country code for this address (e.g. CA, US).',
        });
      }
    }

    return issues;
  }
}
