import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

const VALID_VALUES = new Set(['true', 'false', 'yes', 'no', '1', '0', '']);

export class MarketingConsentRule implements CustomerValidationRule {
  name = 'MarketingConsentRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];
    const columns = ['Accepts Email Marketing', 'Accepts SMS Marketing'];

    for (const row of rows) {
      for (const col of columns) {
        const original = row.original[col] ?? '';
        const value = (row.normalized[col] ?? '').toLowerCase();
        if (!VALID_VALUES.has(value)) {
          issues.push({
            rowNumber: row.rowNumber,
            column: col,
            severity: 'Error',
            issueType: 'InvalidMarketingConsent',
            currentValue: original,
            message: `"${original}" is not a valid value for "${col}".`,
            suggestedFix: 'Use TRUE, FALSE, YES, NO, 1, 0, or leave blank.',
          });
        }
      }
    }

    return issues;
  }
}
