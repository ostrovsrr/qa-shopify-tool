import { describe, expect, it } from 'vitest';
import { notImportedReasons } from '../src/reports/shopifyVerificationReport';

// A row the import deliberately left out used to read a bare "Not imported" in
// the customer verification report. It now says why (TODOS §6).
const IDENTITY = {
  'First Name': 'First Name',
  'Last Name': 'Last Name',
  Email: 'Email',
  'Default Address City': 'Default Address City',
};
const rows = (records: Record<string, string>[]) => records.map((data, i) => ({ rowNumber: i + 2, data }));

describe('notImportedReasons', () => {
  it('names the blank lines dropped by "Name contactless rows"', () => {
    const reasons = notImportedReasons({
      originalRows: rows([
        { 'First Name': 'Ann', 'Last Name': 'A', Email: 'ann@example.com', 'Default Address City': '' },
        { 'First Name': '', 'Last Name': '', Email: '', 'Default Address City': '' },
      ]),
      columnMapping: IDENTITY,
      fillMissingContactName: true,
    });
    expect([...reasons]).toEqual([[3, 'Not imported: blank line']]);
  });

  it('names the row a duplicate was merged into', () => {
    const reasons = notImportedReasons({
      originalRows: rows([
        { 'First Name': 'Ann', 'Last Name': 'A', Email: 'ann@example.com', 'Default Address City': 'Ottawa' },
        { 'First Name': 'Ann', 'Last Name': 'A', Email: 'ann@example.com', 'Default Address City': '' },
      ]),
      columnMapping: IDENTITY,
      mergeMatchingDuplicates: true,
    });
    expect([...reasons]).toEqual([[3, 'Not imported: merged into row 2']]);
  });

  it('has nothing to say when neither option was on', () => {
    const reasons = notImportedReasons({
      originalRows: rows([{ 'First Name': '', 'Last Name': '', Email: '', 'Default Address City': '' }]),
      columnMapping: IDENTITY,
    });
    expect(reasons.size).toBe(0);
  });
});
