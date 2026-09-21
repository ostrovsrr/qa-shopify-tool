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

// The values Shopify rejects outright are cleared into Note so the rest of the
// row still imports. The verdict comes from contactValidity.ts, the same code
// InvalidEmailRule / InvalidPhoneRule report from, so what is stripped here and
// what is flagged there can never disagree.
describe('buildTemplateDataset — moveInvalidContactToNotes', () => {
  it('clears an invalid email into Note and tags the row', () => {
    const { rows, invalidMoved } = buildTemplateDataset({
      originalRows: [orig(2, { 'First Name': 'Ann', Email: 'qa..probe@example.com' })],
      moveInvalidContactToNotes: true,
    });
    expect(rows[0].record['Email']).toBe('');
    expect(rows[0].record['Note']).toBe('Invalid email: qa..probe@example.com');
    expect(rows[0].record['Tags']).toBe('InvalidEmailNotes');
    expect(invalidMoved.has(2)).toBe(true);
  });

  it('clears an invalid phone into Note and tags the row', () => {
    const { rows } = buildTemplateDataset({
      originalRows: [orig(2, { 'First Name': 'Ann', Phone: '555-555-5555' })],
      moveInvalidContactToNotes: true,
    });
    expect(rows[0].record['Phone']).toBe('');
    expect(rows[0].record['Note']).toBe('Invalid phone: 555-555-5555');
    expect(rows[0].record['Tags']).toBe('InvalidPhoneNotes');
  });

  it('leaves valid values alone and keeps an existing Note', () => {
    const { rows, invalidMoved } = buildTemplateDataset({
      originalRows: [
        orig(2, { Email: 'real@example.com', Phone: '+1 613 555 0104', Note: 'keep me' }),
      ],
      moveInvalidContactToNotes: true,
    });
    expect(rows[0].record['Email']).toBe('real@example.com');
    expect(rows[0].record['Phone']).toBe('+1 613 555 0104');
    expect(rows[0].record['Note']).toBe('keep me');
    expect(invalidMoved.size).toBe(0);
  });

  it('appends both to one Note, after the text already there', () => {
    const { rows } = buildTemplateDataset({
      originalRows: [orig(2, { Email: 'bad@@x.com', Phone: 'not a phone', Note: 'existing' })],
      moveInvalidContactToNotes: true,
    });
    expect(rows[0].record['Note']).toBe(
      'existing | Invalid email: bad@@x.com | Invalid phone: not a phone',
    );
    expect(rows[0].record['Tags']).toBe('InvalidEmailNotes,InvalidPhoneNotes');
  });

  // Ordering: stripping runs before the duplicate grouping, so a value that has
  // been cleared cannot also be reported as a duplicate of itself.
  it('does not group two rows sharing one invalid email as duplicates', () => {
    const { rows, emailDupes } = buildTemplateDataset({
      originalRows: [
        orig(2, { 'First Name': 'A', Email: 'bad..dup@x.com' }),
        orig(3, { 'First Name': 'B', Email: 'bad..dup@x.com' }),
      ],
      moveInvalidContactToNotes: true,
      moveDuplicatesToNotes: true,
    });
    expect(emailDupes.groups.size).toBe(0);
    for (const row of rows) {
      expect(row.record['Note']).toBe('Invalid email: bad..dup@x.com');
      expect(row.record['Note']).not.toContain('Duplicate');
    }
  });

  it('changes nothing when the flag is off', () => {
    const originalRows = [orig(2, { Email: 'qa..probe@example.com', Phone: '555-555-5555' })];
    expect(buildTemplateDataset({ originalRows }).rows[0].record).toEqual({
      Email: 'qa..probe@example.com',
      Phone: '555-555-5555',
    });
  });
});

describe('buildTemplateDataset — fillMissingContactName', () => {
  it('names a row that has data but no identity field', () => {
    const { rows, namesFilled } = buildTemplateDataset({
      originalRows: [orig(7, { 'Default Address City': 'Toronto', Tags: 'vip' })],
      fillMissingContactName: true,
    });
    expect(rows[0].record['First Name']).toBe('Unknown 7');
    expect(rows[0].record['Tags']).toBe('vip,NoContactInfo');
    expect(namesFilled.has(7)).toBe(true);
  });

  // toRows() trims only TRAILING blank rows, so a blank line mid-file survives as
  // an all-empty row. It is not a customer, so it leaves the dataset rather than
  // being named (a customer conjured out of a stray newline) or carried (an
  // import failure for a line holding nothing). It stays on the "Full Uploaded
  // File" sheet.
  it('drops a fully blank row instead of naming it', () => {
    const { rows, namesFilled, droppedBlank } = buildTemplateDataset({
      originalRows: [
        orig(4, { 'First Name': '', Email: '', 'Default Address City': 'Toronto' }),
        orig(5, { 'First Name': '', Email: '', 'Default Address City': '' }),
      ],
      fillMissingContactName: true,
    });
    expect(rows.map((r) => r.rowNumber)).toEqual([4]);
    expect(rows[0].record['First Name']).toBe('Unknown 4');
    expect(namesFilled.has(4)).toBe(true);
    expect([...droppedBlank]).toEqual([5]);
  });

  // "Blank" means every MAPPED column is empty, and Keep / Add-to-* columns count
  // as mapped: a row carrying only a kept passthrough value still reaches Shopify,
  // so it is a customer and must survive.
  it('does not treat a row carrying only a Keep column as blank', () => {
    const { rows, namesFilled, droppedBlank } = buildTemplateDataset({
      originalRows: [orig(4, { Email: '', 'Internal ID': 'X-99' })],
      columnMapping: { Email: 'Email', 'Internal ID': 'Keep' },
      fillMissingContactName: true,
    });
    expect(droppedBlank.size).toBe(0);
    expect(rows[0].record['Internal ID']).toBe('X-99');
    expect(rows[0].record['First Name']).toBe('Unknown 4');
    expect(namesFilled.has(4)).toBe(true);
  });

  it('does not treat a row carrying only an Add-to-Note column as blank', () => {
    const { rows, droppedBlank } = buildTemplateDataset({
      originalRows: [orig(4, { Email: '', 'Legacy Ref': 'ref-1' })],
      columnMapping: { Email: 'Email', 'Legacy Ref': 'Add to Note' },
      fillMissingContactName: true,
    });
    expect(droppedBlank.size).toBe(0);
    expect(rows[0].record['Note']).toBe('ref-1');
    expect(rows[0].record['First Name']).toBe('Unknown 4');
  });

  // A column mapped to "Ignore" never reaches Shopify, so a row holding nothing
  // else really would import as an empty customer. It is dropped.
  it('treats a row whose only data is in an IGNORED column as blank', () => {
    const { rows, droppedBlank } = buildTemplateDataset({
      originalRows: [orig(4, { Email: '', 'Internal ID': 'X-99' })],
      columnMapping: { Email: 'Email' },
      fillMissingContactName: true,
    });
    expect(rows).toHaveLength(0);
    expect([...droppedBlank]).toEqual([4]);
  });

  it('keeps blank rows when the flag is off', () => {
    const { rows, droppedBlank } = buildTemplateDataset({
      originalRows: [orig(5, { 'First Name': '', Email: '' })],
    });
    expect(rows.map((r) => r.rowNumber)).toEqual([5]);
    expect(droppedBlank.size).toBe(0);
  });

  it('leaves a row that already has any identity field alone', () => {
    const { rows, namesFilled } = buildTemplateDataset({
      originalRows: [
        orig(2, { 'Last Name': 'Solo', 'Default Address City': 'Toronto' }),
        orig(3, { Phone: '+1 613 555 0104', 'Default Address City': 'Ottawa' }),
      ],
      fillMissingContactName: true,
    });
    expect(rows[0].record['First Name']).toBeUndefined();
    expect(rows[1].record['First Name']).toBeUndefined();
    expect(namesFilled.size).toBe(0);
  });

  it('changes nothing when the flag is off', () => {
    const { rows, namesFilled } = buildTemplateDataset({
      originalRows: [orig(7, { 'Default Address City': 'Toronto' })],
    });
    expect(rows[0].record['First Name']).toBeUndefined();
    expect(namesFilled.size).toBe(0);
  });
});

// The composition the two flags were built for.
describe('buildTemplateDataset — both cleanup flags together', () => {
  it('rescues a row whose only identity was an invalid email', () => {
    const { rows, namesFilled } = buildTemplateDataset({
      originalRows: [orig(4, { Email: 'bad..dup@x.com', 'Default Address City': 'Toronto' })],
      moveInvalidContactToNotes: true,
      fillMissingContactName: true,
    });
    expect(rows[0].record['Email']).toBe('');
    expect(rows[0].record['First Name']).toBe('Unknown 4');
    expect(rows[0].record['Note']).toBe('Invalid email: bad..dup@x.com');
    expect(rows[0].record['Tags']).toBe('InvalidEmailNotes,NoContactInfo');
    expect(namesFilled.has(4)).toBe(true);
  });

  // Blankness is judged BEFORE the strip runs, so the Note that
  // moveInvalidContactToNotes writes cannot make a blank row look substantial
  // and save it from being dropped.
  it('still drops a blank row when both flags are on', () => {
    const { rows, namesFilled, droppedBlank } = buildTemplateDataset({
      originalRows: [orig(5, { Email: '', Phone: '', 'Default Address City': '' })],
      moveInvalidContactToNotes: true,
      fillMissingContactName: true,
    });
    expect(rows).toHaveLength(0);
    expect(namesFilled.size).toBe(0);
    expect([...droppedBlank]).toEqual([5]);
  });

  it('is deterministic with both flags on', () => {
    const opts = {
      originalRows: [
        orig(2, { Email: 'bad..dup@x.com', 'Default Address City': 'Toronto' }),
        orig(3, { 'First Name': 'Ann', Phone: '555-555-5555' }),
      ],
      moveInvalidContactToNotes: true,
      fillMissingContactName: true,
    };
    const a = buildTemplateDataset(opts);
    const b = buildTemplateDataset(opts);
    expect(a.rows.map((r) => r.record)).toEqual(b.rows.map((r) => r.record));
  });
});
