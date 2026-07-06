import { describe, expect, it } from 'vitest';
import { mergeMatchingDuplicateRows, TemplateRow } from '../src/reports/mergeDuplicates';

function row(rowNumber: number, record: Record<string, string>): TemplateRow {
  return { rowNumber, record, mergedFrom: [] };
}

describe('mergeMatchingDuplicateRows', () => {
  it('merges same-email rows with matching names into the most-filled keeper', () => {
    const out = mergeMatchingDuplicateRows([
      row(2, { 'First Name': 'John', 'Last Name': 'Smith', Email: 'j@x.com' }),
      row(3, {
        'First Name': 'john',
        'Last Name': 'SMITH',
        Email: 'J@x.com',
        Phone: '5551234567',
        'Default Address City': 'Toronto',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rowNumber).toBe(3); // more filled
    expect(out[0].mergedFrom).toEqual([2]);
    expect(out[0].record['Phone']).toBe('5551234567');
  });

  it('does not merge same-email rows with different names', () => {
    const out = mergeMatchingDuplicateRows([
      row(2, { 'First Name': 'John', 'Last Name': 'Smith', Email: 'shared@x.com' }),
      row(3, { 'First Name': 'Mary', 'Last Name': 'Jones', Email: 'shared@x.com' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('never merges rows whose names are empty', () => {
    const out = mergeMatchingDuplicateRows([
      row(2, { Email: 'shared@x.com' }),
      row(3, { Email: 'shared@x.com' }),
      row(4, { 'First Name': 'John', 'Last Name': 'Smith', Email: 'shared@x.com' }),
    ]);
    expect(out).toHaveLength(3);
  });

  it('fills the keeper\'s empty fields from merged rows in row order', () => {
    const out = mergeMatchingDuplicateRows([
      row(2, {
        'First Name': 'John',
        'Last Name': 'Smith',
        Email: 'j@x.com',
        'Default Address City': 'Toronto',
        'Default Address Zip': 'M5V 3L9',
      }),
      row(3, { 'First Name': 'John', 'Last Name': 'Smith', Email: 'j@x.com', Phone: '111' }),
      row(4, { 'First Name': 'John', 'Last Name': 'Smith', Email: 'j@x.com', Phone: '222' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rowNumber).toBe(2);
    expect(out[0].mergedFrom).toEqual([3, 4]);
    // keeper had no phone → first merged row's phone wins; keeper's city kept
    expect(out[0].record['Phone']).toBe('111');
    expect(out[0].record['Default Address City']).toBe('Toronto');
  });

  it('unions tags and concatenates notes', () => {
    const out = mergeMatchingDuplicateRows([
      row(2, { 'First Name': 'J', 'Last Name': 'S', Email: 'j@x.com', Tags: 'vip,gold', Note: 'first' }),
      row(3, { 'First Name': 'J', 'Last Name': 'S', Email: 'j@x.com', Tags: 'GOLD, retail', Note: 'second' }),
    ]);
    expect(out[0].record['Tags']).toBe('vip,gold,retail');
    expect(out[0].record['Note']).toBe('first | second');
  });

  it('never escalates consent: conflicting values resolve to FALSE', () => {
    const out = mergeMatchingDuplicateRows([
      row(2, {
        'First Name': 'J',
        'Last Name': 'S',
        Email: 'j@x.com',
        'Accepts Email Marketing': 'TRUE',
        'Tax Exempt': 'yes',
      }),
      row(3, {
        'First Name': 'J',
        'Last Name': 'S',
        Email: 'j@x.com',
        'Accepts Email Marketing': 'FALSE',
        'Tax Exempt': 'yes',
        Phone: '111',
        Note: 'x',
      }),
    ]);
    expect(out[0].record['Accepts Email Marketing']).toBe('FALSE');
    // all rows agree → keeps the value
    expect(out[0].record['Tax Exempt']).toBe('yes');
  });

  it('collapses transitive chains across the email and phone passes', () => {
    const out = mergeMatchingDuplicateRows([
      row(2, { 'First Name': 'J', 'Last Name': 'S', Email: 'j@x.com', Phone: '' }),
      row(3, { 'First Name': 'J', 'Last Name': 'S', Email: 'j@x.com', Phone: '5551234567' }),
      row(4, { 'First Name': 'J', 'Last Name': 'S', Email: '', Phone: '+1 (555) 123-4567' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].mergedFrom.sort()).toEqual([2, 4]);
  });

  it('merges only the matching subset of a larger duplicate group', () => {
    const out = mergeMatchingDuplicateRows([
      row(2, { 'First Name': 'John', 'Last Name': 'Smith', Email: 'shared@x.com' }),
      row(3, { 'First Name': 'John', 'Last Name': 'Smith', Email: 'shared@x.com', Phone: '111' }),
      row(4, { 'First Name': 'Mary', 'Last Name': 'Jones', Email: 'shared@x.com' }),
    ]);
    expect(out).toHaveLength(2);
    const merged = out.find((r) => r.mergedFrom.length > 0)!;
    expect(merged.rowNumber).toBe(3);
    expect(merged.mergedFrom).toEqual([2]);
  });
});
