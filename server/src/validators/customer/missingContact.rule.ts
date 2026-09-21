import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

// Probed against a test store on 2026-09-21 (customerCreate, one synthetic
// customer per shape):
//   accepted: first name only; last name only
//   rejected: no identity at all — "A name, phone number, or email address must
//             be present"
// So the four fields really are an OR, and ONE of them is enough. That is what
// makes the fillMissingContactName option work: a placeholder First Name is
// sufficient for Shopify to accept a row that would otherwise be rejected
// outright. See reports/templateDataset.ts.
export class MissingContactRule implements CustomerValidationRule {
  name = 'MissingContactRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const firstName = row.normalized['First Name'] ?? '';
      const lastName = row.normalized['Last Name'] ?? '';
      const email = row.normalized['Email'] ?? '';
      const phone = row.normalized['Phone'] ?? '';

      if (!firstName && !lastName && !email && !phone) {
        issues.push({
          rowNumber: row.rowNumber,
          column: 'First Name / Last Name / Email / Phone',
          severity: 'Error',
          issueType: 'MissingContact',
          currentValue: '',
          message: 'All identity fields are blank (First Name, Last Name, Email, Phone). At least one must be present.',
          suggestedFix: 'Add at least a First Name, Last Name, Email, or Phone.',
        });
      }
    }

    return issues;
  }
}
