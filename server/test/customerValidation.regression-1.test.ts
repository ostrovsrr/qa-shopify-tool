import { describe, expect, it } from 'vitest';
import { runCustomerValidationDetailed } from '../src/services/customerValidation.service';
import { makeRows } from './helpers';

// Regression: ISSUE-C1 — with "Name contactless rows" on, a blank line mid-file
// was silently left out of the import: validation said 9 rows, the import said
// 8 of 8, and nothing said where the ninth went.
// Found by /qa on 2026-09-22
// Report: .gstack/qa-reports/qa-report-localhost-2026-09-22-customers.md
describe('runCustomerValidationDetailed reports the blank lines it drops', () => {
  const rows = () =>
    makeRows([
      { 'First Name': 'Ann', Email: 'ann@example.com' },
      { 'First Name': '', Email: '', Phone: '', 'Default Address City': '' },
      { 'First Name': '', Email: '', Phone: '', 'Default Address City': 'Ottawa' },
      { 'First Name': '', Email: '', Phone: '', 'Default Address City': '' },
    ]);

  it('lists every fully blank row, in row order, when the option is on', () => {
    const { issues, droppedBlankRows } = runCustomerValidationDetailed(rows(), {}, { fillMissingContactName: true });
    expect(droppedBlankRows).toEqual([3, 5]);
    // The city-only row is named, not dropped, and nothing is left to flag.
    expect(issues).toEqual([]);
  });

  it('drops nothing when the option is off (blank rows stay MissingContact errors)', () => {
    const { issues, droppedBlankRows } = runCustomerValidationDetailed(rows(), {});
    expect(droppedBlankRows).toEqual([]);
    expect(issues.filter((i) => i.issueType === 'MissingContact').map((i) => i.rowNumber)).toEqual([3, 4, 5]);
  });
});
