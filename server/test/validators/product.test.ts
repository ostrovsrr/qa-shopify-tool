import { describe, expect, it } from 'vitest';
import { ProductGroup } from '../../src/types';
import { runProductValidation } from '../../src/validators/product';
import { DuplicateVariantRule } from '../../src/validators/product/duplicateVariant.rule';
import { GiftCardRule } from '../../src/validators/product/giftCard.rule';
import { ProductFieldsRule } from '../../src/validators/product/productFields.rule';
import { compareProductIssues } from '../../src/validators/product';
import { LONG } from '../../scripts/rejectionProbe/cases';

// One Handle group from plain records; row numbers start at 2 like a real CSV.
function group(handle: string, records: Record<string, string>[], firstRow = 2): ProductGroup {
  return {
    handle,
    rows: records.map((r, i) => {
      const record = { Handle: handle, ...r };
      return { rowNumber: firstRow + i, original: record, normalized: record };
    }),
  };
}

describe('DuplicateVariantRule', () => {
  const rule = new DuplicateVariantRule();

  // Seen in a real file: several priced rows with no options → two "Default Title".
  it('flags option-less rows that each carry variant data', () => {
    const issues = rule.validate([
      group('chicken-bone', [
        { Title: 'Chicken Bone', 'Variant SKU': 'A', 'Variant Price': '5' },
        { 'Variant SKU': 'B', 'Variant Price': '6' },
      ]),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rowNumber: 3, handle: 'chicken-bone', issueType: 'DuplicateVariant' });
  });

  it('flags a repeated option-value combination', () => {
    const issues = rule.validate([
      group('beans', [
        { 'Option1 Name': 'Size', 'Option1 Value': '454g' },
        { 'Option1 Value': '1kg' },
        { 'Option1 Value': '454g' },
      ]),
    ]);
    expect(issues.map((i) => i.rowNumber)).toEqual([4]);
    expect(issues[0].message).toContain('repeats row 2');
  });

  it('does not count trailing image-only rows as variants', () => {
    const issues = rule.validate([
      group('mug', [
        { 'Variant SKU': 'MUG', 'Image Src': 'https://x/1.jpg' },
        { 'Image Src': 'https://x/2.jpg' },
        { 'Image Src': 'https://x/3.jpg' },
      ]),
    ]);
    expect(issues).toHaveLength(0);
  });

  it('does not flag distinct variants', () => {
    const issues = rule.validate([
      group('tee', [
        { 'Option1 Name': 'Color', 'Option2 Name': 'Size', 'Option1 Value': 'Black', 'Option2 Value': 'S' },
        { 'Option1 Value': 'Black', 'Option2 Value': 'M' },
        { 'Option1 Value': 'White', 'Option2 Value': 'S' },
      ]),
    ]);
    expect(issues).toHaveLength(0);
  });
});

describe('DuplicateVariantRule with blank option values', () => {
  const rule = new DuplicateVariantRule();

  // The admin import fills a blank option value in as "Default Title" rather
  // than rejecting it (observed 2026-09-22), so one blank row is fine...
  it('does not flag a single blank option value', () => {
    const issues = rule.validate([
      group('opals', [
        { 'Option1 Name': 'Size', 'Option1 Value': 'S' },
        { 'Option1 Value': '', 'Variant SKU': 'B' },
      ]),
    ]);
    expect(issues).toHaveLength(0);
  });

  // ...but two blank rows are both "Default Title" and collide.
  it('flags a second blank option value as a duplicate of the first', () => {
    const issues = rule.validate([
      group('opals', [
        { 'Option1 Name': 'Size', 'Option1 Value': 'S' },
        { 'Option1 Value': '', 'Variant SKU': 'B' },
        { 'Option1 Value': '', 'Variant SKU': 'C' },
      ]),
    ]);
    expect(issues.map((i) => i.rowNumber)).toEqual([4]);
    expect(issues[0].message).toContain('A blank option value imports as "Default Title"');
    expect(issues[0].message).toContain("The variant 'Default Title' already exists.");
  });
});

describe('GiftCardRule', () => {
  const rule = new GiftCardRule();

  it('flags a gift card product and leaves ordinary products alone', () => {
    const issues = rule.validate([
      group('gift-card-GC', [{ 'Gift Card': 'TRUE' }]),
      group('mug', [{ 'Gift Card': 'FALSE' }], 3),
      group('tee', [{}], 4),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ handle: 'gift-card-GC', issueType: 'GiftCardProduct' });
  });
});

describe('runProductValidation', () => {
  it('returns every rule\'s findings in row order, all as errors', () => {
    const issues = runProductValidation([
      group('gift-card-GC', [{ Title: 'Gift card', 'Gift Card': 'yes' }], 9),
      group('beans', [{ Title: 'Beans', 'Variant SKU': 'A' }, { 'Variant SKU': 'B' }], 2),
    ]);
    expect(issues.map((i) => [i.rowNumber, i.issueType])).toEqual([
      [3, 'DuplicateVariant'],
      [9, 'GiftCardProduct'],
    ]);
    expect(issues.every((i) => i.severity === 'Error')).toBe(true);
  });
});

// TODOS §5: a whole-file message quoted Shopify's wording, which already opens
// with a quote, and read `...fixed): ""abc" is not a valid price"`.
describe('pre-check message quoting', () => {
  it('does not double the quotes around Shopify\'s own wording', () => {
    const issues = runProductValidation([group('p', [{ Title: 'P', 'Variant Price': 'abc' }])]);
    const money = issues.find((i) => i.issueType === 'UnreadableMoney')!;
    expect(money.message).toContain(': "abc" is not a valid price');
    expect(money.message).not.toContain('""');
  });
});

// The builder sends col(first, 'Type', 'Product Type') — the first NON-EMPTY of
// the two. The rule used to judge the first column that merely EXISTED, so a
// blank Type hid a 300-character Product Type that the import then sent (and
// Shopify rejected: probe type-long).
describe('ProductFieldsRule reads Type the way the builder sends it', () => {
  const rule = new ProductFieldsRule();

  it('flags a long Product Type behind a blank Type, naming Product Type', () => {
    const issues = rule.validate([group('p', [{ Title: 'P', Type: '', 'Product Type': LONG }])]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ issueType: 'FieldTooLong', column: 'Product Type', currentValue: LONG });
    expect(issues[0].message).toContain('Product type is too long (maximum is 255 characters)');
  });

  it('does not flag a long Product Type that a filled Type overrides', () => {
    const issues = rule.validate([group('p', [{ Title: 'P', Type: 'Shirts', 'Product Type': LONG }])]);
    expect(issues).toEqual([]);
  });

  it('still flags a long Type', () => {
    const issues = rule.validate([group('p', [{ Title: 'P', Type: LONG, 'Product Type': 'Shirts' }])]);
    expect(issues.map((i) => i.column)).toEqual(['Type']);
  });
});

describe('number cells too large to read', () => {
  it('says a huge price is too large, not that it has no number', () => {
    const issues = runProductValidation([group('p', [{ Title: 'P', 'Variant Price': '9'.repeat(400) }])]);
    const money = issues.find((i) => i.issueType === 'UnreadableMoney')!;
    expect(money.message).toContain('too large');
    expect(money.message).not.toContain('has no number');
  });

  it('flags grams too large for a double instead of sending a null weight', () => {
    const issues = runProductValidation([group('p', [{ Title: 'P', 'Variant Grams': '1e999' }])]);
    expect(issues.map((i) => i.issueType)).toEqual(['InvalidWeight']);
    expect(issues[0].message).toContain('too large');
  });
});

// The upload response, the upload detail and the Excel sheet all list issues
// in compareProductIssues order; runProductValidation (the upload response)
// used to sort by row only, leaving rule order within a row.
describe('pre-check issue order', () => {
  it('sorts by row, then issue type, then column', () => {
    const issues = runProductValidation([
      group('p', [{ Title: '', 'Variant SKU': LONG, 'Variant Barcode': LONG, 'Variant Price': 'abc' }]),
    ]);
    expect(issues.map((i) => [i.issueType, i.column])).toEqual([
      ['FieldTooLong', 'Variant Barcode'],
      ['FieldTooLong', 'Variant SKU'],
      ['MissingTitle', 'Title'],
      ['UnreadableMoney', 'Variant Price'],
    ]);
    expect([...issues].sort(compareProductIssues)).toEqual(issues);
  });
});
