import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

const CA_PROVINCES: Set<string> = new Set([
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
]);

const US_STATES: Set<string> = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'AS', 'GU', 'MP', 'PR', 'VI',
]);

const CA_IDENTIFIERS = new Set(['canada', 'ca']);
const US_IDENTIFIERS = new Set(['united states', 'united states of america', 'us', 'usa']);

export class ProvinceCodeRule implements CustomerValidationRule {
  name = 'ProvinceCodeRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const provinceCode = (row.normalized['Default Address Province Code'] ?? '').trim();
      const country = (row.normalized['Default Address Country Code'] ?? '').toLowerCase().trim();

      if (!provinceCode || !country) continue;

      const provinceUpper = provinceCode.toUpperCase();

      if (CA_IDENTIFIERS.has(country)) {
        if (!CA_PROVINCES.has(provinceUpper)) {
          issues.push({
            rowNumber: row.rowNumber,
            column: 'Default Address Province Code',
            severity: 'Error',
            issueType: 'InvalidProvinceCode',
            currentValue: row.original['Default Address Province Code'] ?? provinceCode,
            message: `"${provinceCode}" is not a valid Canadian province/territory code.`,
            suggestedFix: `Use a 2-letter code: AB, BC, MB, NB, NL, NS, NT, NU, ON, PE, QC, SK, YT.`,
          });
        }
      } else if (US_IDENTIFIERS.has(country)) {
        if (!US_STATES.has(provinceUpper)) {
          issues.push({
            rowNumber: row.rowNumber,
            column: 'Default Address Province Code',
            severity: 'Error',
            issueType: 'InvalidProvinceCode',
            currentValue: row.original['Default Address Province Code'] ?? provinceCode,
            message: `"${provinceCode}" is not a valid US state/territory code.`,
            suggestedFix: `Use a 2-letter USPS state abbreviation (e.g. ON → should be a US state; check if country is correct).`,
          });
        }
      }
    }

    return issues;
  }
}
