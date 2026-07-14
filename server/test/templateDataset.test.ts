import { describe, expect, it } from 'vitest';
import { buildTemplateDataset } from '../src/reports/templateDataset';

function orig(rowNumber: number, data: Record<string, string>) {
  return { rowNumber, data };
}

// The import's reconcile rebuilds the row list from scratch to map bulk-result
// lines back to CSV rows, so the transformation must be deterministic and the
// surviving rowNumbers must match what buildJsonl sent.
describe('buildTemplateDataset', () => {
  const dupRows = [
    orig(2, { 'First Name': 'John', 'Last Name': 'Smith', Email: 'j@x.com', Phone: '' }),
    orig(3, {
      'First Name': 'john',
      'Last Name': 'SMITH',
      Email: 'J@x.com',
      Phone: '+1 555 123 4567',
    }),
    orig(4, { 'First Name': 'Mary', 'Last Name': 'Jones', Email: 'mary@x.com', Phone: '' }),
  ];

  it('passes rows through unchanged when no options are on', () => {
    const { rows, anyMerges } = buildTemplateDataset({ originalRows: dupRows });
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 3, 4]);
    expect(anyMerges).toBe(false);
    expect(rows[0].record['Email']).toBe('j@x.com');
  });

  it('drops absorbed rows when merging, keeping the most-filled keeper', () => {
    const { rows, anyMerges } = buildTemplateDataset({
      originalRows: dupRows,
      mergeMatchingDuplicates: true,
    });
    expect(anyMerges).toBe(true);
    expect(rows.map((r) => r.rowNumber)).toEqual([3, 4]);
    expect(rows[0].mergedFrom).toEqual([2]);
  });

  it('strips duplicated identifiers into Note on non-keeper rows when moving to Notes', () => {
    const { rows } = buildTemplateDataset({
      originalRows: [
        orig(2, { 'First Name': 'A', Email: 'dup@x.com', Phone: '', Note: '' }),
        orig(3, {
          'First Name': 'B',
          Email: 'dup@x.com',
          Phone: '5551234567',
          Note: 'existing',
        }),
      ],
      moveDuplicatesToNotes: true,
    });
    // Row 3 is more filled → keeper keeps its email; row 2 is stripped.
    const stripped = rows.find((r) => r.rowNumber === 2)!;
    const keeper = rows.find((r) => r.rowNumber === 3)!;
    expect(stripped.record['Email']).toBe('');
    expect(stripped.record['Note']).toContain('Duplicate email: dup@x.com');
    expect(stripped.record['Tags']).toContain('DuplicateEmailNotes');
    expect(keeper.record['Email']).toBe('dup@x.com');
    expect(keeper.record['Note']).toBe('existing');
  });

  it('is deterministic: two runs over the same input produce identical rows', () => {
    const opts = {
      originalRows: dupRows,
      mergeMatchingDuplicates: true,
      moveDuplicatesToNotes: true,
    };
    const a = buildTemplateDataset(opts);
    const b = buildTemplateDataset(opts);
    expect(a.rows.map((r) => r.rowNumber)).toEqual(b.rows.map((r) => r.rowNumber));
    expect(a.rows.map((r) => r.record)).toEqual(b.rows.map((r) => r.record));
  });

  it('applies the column mapping and drops unmapped columns', () => {
    const { rows } = buildTemplateDataset({
      originalRows: [orig(2, { 'E-mail': 'a@x.com', Junk: 'ignore me' })],
      columnMapping: { 'E-mail': 'Email' },
    });
    expect(rows[0].record).toEqual({ Email: 'a@x.com' });
  });
});
