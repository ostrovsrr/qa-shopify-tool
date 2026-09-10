import { describe, expect, it } from 'vitest';
import { ProductGroup } from '../../src/types';
import { runProductValidation } from '../../src/validators/product';
import { DuplicateVariantRule } from '../../src/validators/product/duplicateVariant.rule';
import { MissingOptionValueRule } from '../../src/validators/product/missingOptionValue.rule';
import { GiftCardRule } from '../../src/validators/product/giftCard.rule';

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

describe('MissingOptionValueRule', () => {
  const rule = new MissingOptionValueRule();

  // Seen in a real file: a stray "Variant" row inside a Color/Size product.
  it('flags a variant row with no value for a declared option, and names the stray option set', () => {
    const issues = rule.validate([
      group('opals', [
        { 'Option1 Name': 'Color', 'Option2 Name': 'Size', 'Option1 Value': 'Teal/TE', 'Option2 Value': '3mm' },
        { 'Option1 Name': 'Variant', 'Option1 Value': 'Copy of Opals White' },
      ]),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rowNumber: 3, issueType: 'MissingOptionValue' });
    expect(issues[0].message).toContain('"Size"');
    expect(issues[0].message).toContain('declares options "Variant"');
  });

  it('ignores products without declared options', () => {
    expect(rule.validate([group('plain', [{ 'Variant SKU': 'A' }])])).toHaveLength(0);
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
      group('gift-card-GC', [{ 'Gift Card': 'yes' }], 9),
      group('beans', [{ 'Variant SKU': 'A' }, { 'Variant SKU': 'B' }], 2),
    ]);
    expect(issues.map((i) => [i.rowNumber, i.issueType])).toEqual([
      [3, 'DuplicateVariant'],
      [9, 'GiftCardProduct'],
    ]);
    expect(issues.every((i) => i.severity === 'Error')).toBe(true);
  });
});
