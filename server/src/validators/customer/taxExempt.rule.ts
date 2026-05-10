import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

const VALID_VALUES = new Set(['true', 'false', 'yes', 'no', '1', '0', '']);

export class TaxExemptRule implements CustomerValidationRule {
  name = 'TaxExemptRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const original = row.original['Tax Exempt'] ?? '';
      const value = (row.normalized['Tax Exempt'] ?? '').toLowerCase();
      if (!VALID_VALUES.has(value)) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Tax Exempt',
          severity: 'Error',
          issueType: 'InvalidTaxExempt',
          currentValue: original,
          message: `"${original}" is not a valid value for "Tax Exempt".`,
          suggestedFix: 'Use TRUE, FALSE, YES, NO, 1, 0, or leave blank.',
        });
      }
    }

    return issues;
  }
}
