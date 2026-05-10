import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

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
      if (duplicateRows.length > 1) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Email',
          severity: 'Error',
          issueType: 'DuplicateEmail',
          currentValue: row.original['Email'] ?? '',
          message: `Email "${email}" appears in rows: ${duplicateRows.join(', ')}.`,
          suggestedFix: 'Remove or correct the duplicate email address.',
        });
      }
    }

    return issues;
  }
}
