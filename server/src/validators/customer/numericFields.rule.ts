import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

const NUMERIC_COLUMNS = ['Total Spent', 'Total Orders'];

export class NumericFieldsRule implements CustomerValidationRule {
  name = 'NumericFieldsRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      for (const col of NUMERIC_COLUMNS) {
        const value = row.normalized[col] ?? '';
        if (!value) continue;

        const num = Number(value);

        if (isNaN(num)) {
          issues.push({
            rowNumber: row.rowNumber,
            column: col,
            severity: 'Warning',
            issueType: 'NonNumericField',
            currentValue: row.original[col] ?? '',
            message: `"${value}" in "${col}" is not a valid number.`,
            suggestedFix: `Provide a numeric value for "${col}".`,
          });
        } else if (num < 0) {
          issues.push({
            rowNumber: row.rowNumber,
            column: col,
            severity: 'Warning',
            issueType: 'NegativeNumericField',
            currentValue: row.original[col] ?? '',
            message: `"${col}" has a negative value (${value}).`,
            suggestedFix: `"${col}" should be 0 or greater.`,
          });
        }
      }
    }

    return issues;
  }
}
