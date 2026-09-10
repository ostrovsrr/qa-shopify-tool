import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

// Shopify keeps ONE customer per email and loses the rest: the test import accepts
// the first row and rejects the others ("Email has already been taken"); a CSV
// import in the admin keeps the last and skips the others. Either way a group of N
// loses N-1 rows, so every row after the first is flagged and the first is not.
export class DuplicateEmailRule implements CustomerValidationRule {
  name = 'DuplicateEmailRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];
    const emailMap = new Map<string, number[]>();

    for (const row of rows) {
      const email = (row.normalized['Email'] ?? '').toLowerCase();
      if (!email) continue;
      const existing = emailMap.get(email) ?? [];
      existing.push(row.rowNumber);
      emailMap.set(email, existing);
    }

    for (const row of rows) {
      const email = (row.normalized['Email'] ?? '').toLowerCase();
      if (!email) continue;
      const duplicateRows = emailMap.get(email) ?? [];
      if (duplicateRows.length > 1 && duplicateRows[0] !== row.rowNumber) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Email',
          severity: 'Error',
          issueType: 'DuplicateEmail',
          currentValue: row.original['Email'] ?? '',
          message: `Email "${email}" appears in rows: ${duplicateRows.join(', ')}. Shopify keeps one customer per email, so all but one of these rows will not import.`,
          suggestedFix: 'Remove or correct the duplicate email address, or turn on "Move duplicates to Notes".',
        });
      }
    }

    return issues;
  }
}
