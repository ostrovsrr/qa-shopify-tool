import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

// Project convention — Shopify has no documented note length limit
const MAX_NOTE_LENGTH = 500;

export class LongNoteRule implements CustomerValidationRule {
  name = 'LongNoteRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const note = row.normalized['Note'] ?? '';
      if (note.length > MAX_NOTE_LENGTH) {
        const preview = note.length > 100 ? `${note.substring(0, 100)}...` : note;
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Note',
          severity: 'Warning',
          issueType: 'LongNote',
          currentValue: preview,
          message: `Note is ${note.length} characters long (recommended maximum: ${MAX_NOTE_LENGTH}).`,
          suggestedFix: `Shorten the note to under ${MAX_NOTE_LENGTH} characters.`,
        });
      }
    }

    return issues;
  }
}
