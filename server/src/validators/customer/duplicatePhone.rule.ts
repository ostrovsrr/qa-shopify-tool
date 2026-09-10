import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';
import { canonicalPhone } from '../../utils/normalize';

// Same shape as DuplicateEmailRule: Shopify keeps one customer per phone, so every
// row after the first in a group is flagged and the first is not.
export class DuplicatePhoneRule implements CustomerValidationRule {
  name = 'DuplicatePhoneRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];
    const phoneMap = new Map<string, number[]>();

    for (const row of rows) {
      const phone = row.normalized['Phone'] ?? '';
      if (!phone) continue;
      const normalized = canonicalPhone(phone);
      if (!normalized) continue;
      const existing = phoneMap.get(normalized) ?? [];
      existing.push(row.rowNumber);
      phoneMap.set(normalized, existing);
    }

    for (const row of rows) {
      const phone = row.normalized['Phone'] ?? '';
      if (!phone) continue;
      const normalized = canonicalPhone(phone);
      if (!normalized) continue;
      const duplicateRows = phoneMap.get(normalized) ?? [];
      if (duplicateRows.length > 1 && duplicateRows[0] !== row.rowNumber) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Phone',
          severity: 'Error',
          issueType: 'DuplicatePhone',
          currentValue: row.original['Phone'] ?? '',
          message: `Phone "${phone}" (normalized: ${normalized}) appears in rows: ${duplicateRows.join(', ')}. Shopify keeps one customer per phone, so all but one of these rows will not import.`,
          suggestedFix: 'Remove or correct the duplicate phone number, or turn on "Move duplicates to Notes".',
        });
      }
    }

    return issues;
  }
}
