import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';
import { emailProblem } from './contactValidity';

// The verdict itself lives in contactValidity.ts, shared with the template
// dataset so the value this rule flags and the value that gets stripped into
// Note are decided by the same code. That file carries the probe notes.
export class InvalidEmailRule implements CustomerValidationRule {
  name = 'InvalidEmailRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const email = row.normalized['Email'] ?? '';
      if (!email) continue;
      const found = emailProblem(email);
      if (!found) continue;
      issues.push({
        rowNumber: row.rowNumber,
        column: 'Email',
        severity: 'Error',
        issueType: 'InvalidEmail',
        currentValue: row.original['Email'] ?? '',
        message: found.message,
        suggestedFix: found.fix,
      });
    }

    return issues;
  }
}
