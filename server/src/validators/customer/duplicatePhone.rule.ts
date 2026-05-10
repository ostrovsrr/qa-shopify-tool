import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

export class DuplicatePhoneRule implements CustomerValidationRule {
  name = 'DuplicatePhoneRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];
    const phoneMap = new Map<string, number[]>();

    for (const row of rows) {
      const phone = row.normalized['Phone'] ?? '';
      if (!phone) continue;
      const normalized = phone.replace(/\D/g, '');
      if (!normalized) continue;
      const existing = phoneMap.get(normalized) ?? [];
      existing.push(row.rowNumber);
      phoneMap.set(normalized, existing);
    }

    for (const row of rows) {
      const phone = row.normalized['Phone'] ?? '';
      if (!phone) continue;
      const normalized = phone.replace(/\D/g, '');
      if (!normalized) continue;
      const duplicateRows = phoneMap.get(normalized) ?? [];
      if (duplicateRows.length > 1) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Phone',
          severity: 'Error',
          issueType: 'DuplicatePhone',
          currentValue: row.original['Phone'] ?? '',
          message: `Phone "${phone}" (normalized: ${normalized}) appears in rows: ${duplicateRows.join(', ')}.`,
          suggestedFix: 'Remove or correct the duplicate phone number.',
        });
      }
    }

    return issues;
  }
}
