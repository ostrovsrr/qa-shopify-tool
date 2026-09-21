import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';
import { phoneProblem } from './contactValidity';

// The verdict itself lives in contactValidity.ts, shared with the template
// dataset so the value this rule flags and the value that gets stripped into
// Note are decided by the same code. That file carries the probe notes and the
// scoring against 10,034 real imported phones.
export class InvalidPhoneRule implements CustomerValidationRule {
  name = 'InvalidPhoneRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const phone = row.normalized['Phone'] ?? '';
      if (!phone) continue;
      const found = phoneProblem(phone);
      if (!found) continue;
      issues.push({
        rowNumber: row.rowNumber,
        column: 'Phone',
        severity: 'Error',
        issueType: 'InvalidPhone',
        currentValue: row.original['Phone'] ?? '',
        message: found.message,
        suggestedFix: found.fix,
      });
    }

    return issues;
  }
}
