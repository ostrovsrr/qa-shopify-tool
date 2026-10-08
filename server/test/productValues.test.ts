import { describe, expect, it } from 'vitest';
import {
  gramsIsTooLarge,
  isValidImageUrl,
  MAX_QUANTITY,
  MIN_QUANTITY,
  moneyIsTooLarge,
  parseGrams,
  parseInventoryPolicy,
  parseMoney,
  parseQuantity,
  parseStatus,
} from '../src/services/productValues';

// Every expectation below is a value Shopify's admin CSV import actually stored
// (or refused) on a test store on 2026-09-22 — not a guess about Shopify.

describe('parseMoney', () => {
  it.each([
    ['10.00', 10],
    ['$10.00', 10],
    ['10 USD', 10],
    ['1,000.00', 1000],
    ['10,50', 10.5],
    ['10.999', 11],
    ['1e2', 1],
    ['.5', 0.5],
    ['10.', 10],
    ['-5.00', -5],
  ])('reads %s as %s', (raw, expected) => {
    expect(parseMoney(raw)).toBe(expected);
  });

  it('treats a cell with no number as unreadable (the whole file is refused)', () => {
    expect(parseMoney('abc')).toBe('invalid');
    expect(parseMoney('cheap')).toBe('invalid');
  });

  it('treats blank as absent', () => {
    expect(parseMoney('  ')).toBeNull();
  });
});

describe('parseGrams', () => {
  it.each([
    ['100', 100],
    ['100g', 100],
    ['100.5', 100.5],
    ['1e3', 1000],
    ['1,000', 1], // the comma ends the number — Shopify stored 1 g
    ['-5', -5], // read, then rejected as negative
  ])('reads %s as %s', (raw, expected) => {
    expect(parseGrams(raw)).toBe(expected);
  });

  it('rejects a value with no leading number', () => {
    expect(parseGrams('heavy')).toBe('invalid');
  });
});

describe('parseQuantity', () => {
  it.each([
    ['5', 5],
    ['1.5', 1],
    ['1,000', 1],
    ['-3', -3],
    ['ten', 0],
  ])('reads %s as %s', (raw, expected) => {
    expect(parseQuantity(raw)).toBe(expected);
  });
});

// Edge cases of the number reading itself. The admin rounds money half-up
// (10.999 → 11.00, probe price-three-decimals); these hold the same rule on
// values a double cannot represent exactly, and keep a number too large for a
// double from passing as a value.
describe('number reading edge cases', () => {
  it.each([
    ['1.005', 1.01],
    ['10.995', 11],
    ['2.675', 2.68],
    ['0.125', 0.13],
    ['1.004', 1],
    ['1,005.005', 1005.01],
    ['-1.005', -1.01],
  ])('rounds money %s half-up to %s', (raw, expected) => {
    expect(parseMoney(raw)).toBe(expected);
  });

  it('does not return a negative zero for money that rounds to nothing', () => {
    expect(Object.is(parseMoney('-0.001'), 0)).toBe(true);
  });

  it('treats a money cell too long for a double as unreadable, and says why', () => {
    const huge = '9'.repeat(400);
    expect(parseMoney(huge)).toBe('invalid');
    expect(moneyIsTooLarge(huge)).toBe(true);
    expect(moneyIsTooLarge('abc')).toBe(false);
    expect(moneyIsTooLarge('10.00')).toBe(false);
  });

  it('treats grams too large for a double as unreadable, and says why', () => {
    expect(parseGrams('1e999')).toBe('invalid');
    expect(gramsIsTooLarge('1e999')).toBe(true);
    expect(gramsIsTooLarge('heavy')).toBe(false);
    expect(gramsIsTooLarge('100')).toBe(false);
  });

  it('clamps a quantity to what productSet can carry instead of failing the product', () => {
    expect(parseQuantity('99999999999')).toBe(MAX_QUANTITY);
    expect(parseQuantity('-99999999999')).toBe(MIN_QUANTITY);
    expect(parseQuantity('9'.repeat(400))).toBe(MAX_QUANTITY);
    expect(parseQuantity('2147483647')).toBe(2147483647);
  });
});

describe('parseInventoryPolicy', () => {
  it('accepts deny/continue in any case and with spaces', () => {
    expect(parseInventoryPolicy('Deny')).toBe('DENY');
    expect(parseInventoryPolicy('CONTINUE')).toBe('CONTINUE');
    expect(parseInventoryPolicy(' continue')).toBe('CONTINUE');
  });
  it('separates blank (whole file refused) from invalid (product rejected)', () => {
    expect(parseInventoryPolicy('')).toBe('blank');
    expect(parseInventoryPolicy('maybe')).toBe('invalid');
  });
});

describe('parseStatus', () => {
  it('accepts the four statuses in any case', () => {
    expect(parseStatus('Active')).toBe('ACTIVE');
    expect(parseStatus('DRAFT')).toBe('DRAFT');
    expect(parseStatus('unlisted')).toBe('UNLISTED');
    expect(parseStatus('archived')).toBe('ARCHIVED');
  });
  it('defers a blank status and rejects anything else', () => {
    expect(parseStatus('')).toBeNull();
    expect(parseStatus('live')).toBe('invalid');
  });
});

describe('isValidImageUrl', () => {
  it('accepts a web address even if it cannot be downloaded', () => {
    expect(isValidImageUrl('https://example.invalid/missing.jpg')).toBe(true);
  });
  it('rejects something that is not a web address', () => {
    expect(isValidImageUrl('not a url')).toBe(false);
  });
});
