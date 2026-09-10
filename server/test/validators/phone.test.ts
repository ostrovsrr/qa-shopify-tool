import { describe, expect, it } from 'vitest';
import { InvalidPhoneRule } from '../../src/validators/customer/invalidPhone.rule';
import { DuplicatePhoneRule } from '../../src/validators/customer/duplicatePhone.rule';
import { makeRows } from '../helpers';

describe('InvalidPhoneRule', () => {
  const rule = new InvalidPhoneRule();

  // All fixtures are synthetic. The shapes are real — each mirrors a number Shopify
  // accepted or rejected in a test-store import — but the digits are not a customer's.
  it('accepts real numbers in the formats Shopify takes', () => {
    for (const ok of ['6135551212', '+1 (613) 555-1212', '613.555.1212', '17085550123', '+33 6 12 34 56 78', '+221 77 123 45 67']) {
      expect(rule.validate(makeRows([{ Phone: ok }])), `expected "${ok}" to pass`).toHaveLength(0);
    }
  });

  // Shopify imported apostrophe-prefixed numbers of both shapes as written.
  it("ignores Excel's leading apostrophe text marker", () => {
    expect(rule.validate(makeRows([{ Phone: "'17085550123" }, { Phone: "'+33 6 12 34 56 78" }]))).toHaveLength(0);
    expect(rule.validate(makeRows([{ Phone: "'771234567" }]))).toHaveLength(1);
  });

  // Each shape is one Shopify rejected with "Phone is invalid" in a real test-store
  // import, and every one had the right digit count for the old rule.
  it('errors on numbers Shopify rejected despite a plausible digit count', () => {
    const rejected = [
      '9872345678', // area code 987 not in service
      '7102345678', // 710 is reserved
      '6171550143', // exchange starts with 1
      '8080550143', // exchange starts with 0
      '15551234567', // 555 is not an area code
      '1-555-765-43-21',
      '59055501437', // 11 digits not starting with 1: an international number missing its +
      '221771234567', // Senegal number missing its +
    ];
    for (const bad of rejected) {
      const issues = rule.validate(makeRows([{ Phone: bad }]));
      expect(issues, `expected "${bad}" to be flagged`).toHaveLength(1);
      expect(issues[0].issueType).toBe('InvalidPhone');
    }
  });

  // The probe: "+1 403-555-0123 ext 12" was rejected; libphonenumber alone calls it valid.
  it('errors on a number with an extension', () => {
    const issues = rule.validate(makeRows([{ Phone: '+1 403-555-0123 ext 12' }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('extension');
  });

  it('errors on Excel scientific notation', () => {
    const issues = rule.validate(makeRows([{ Phone: '1.23456E+11' }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('Error');
    expect(issues[0].message).toContain('scientific notation');
  });

  // Shopify rejected "welcome15" at import; the old rule skipped anything with letters.
  it('errors on values that are not phone numbers', () => {
    for (const bad of ['welcome15', '555-CALL-NOW']) {
      const issues = rule.validate(makeRows([{ Phone: bad }]));
      expect(issues, `expected "${bad}" to be flagged`).toHaveLength(1);
      expect(issues[0].message).toContain('not a phone number');
    }
  });

  it('errors when there are too few or too many digits', () => {
    expect(rule.validate(makeRows([{ Phone: '12345' }]))[0].severity).toBe('Error');
    expect(rule.validate(makeRows([{ Phone: '12345678901234567' }]))[0].severity).toBe('Error');
  });

  it('ignores blank phones', () => {
    expect(rule.validate(makeRows([{ Phone: '' }]))).toHaveLength(0);
  });
});

describe('DuplicatePhoneRule', () => {
  const rule = new DuplicatePhoneRule();

  // Shopify keeps one customer per phone (the probe accepted the first row and
  // rejected the repeat as "already been taken"), so only repeats are flagged.
  it('flags the repeat after stripping non-digits, not the first row', () => {
    const issues = rule.validate(
      makeRows([{ Phone: '(555) 123-4567' }, { Phone: '5551234567' }, { Phone: '5559999999' }]),
    );
    expect(issues.map((i) => i.rowNumber)).toEqual([3]);
    expect(issues.every((i) => i.issueType === 'DuplicatePhone')).toBe(true);
  });

  it('does not flag distinct numbers', () => {
    expect(rule.validate(makeRows([{ Phone: '5551110000' }, { Phone: '5552220000' }]))).toHaveLength(0);
  });

  it('treats a NANP number with and without the +1 country code as the same number', () => {
    const issues = rule.validate(
      makeRows([{ Phone: '+12898851714' }, { Phone: '2898851714' }, { Phone: '+1 (289) 885-1714' }]),
    );
    // all three canonicalize to 2898851714 → the second and third repeat the first
    expect(issues.map((i) => i.rowNumber)).toEqual([3, 4]);
    expect(issues.every((i) => i.issueType === 'DuplicatePhone')).toBe(true);
  });

  it('does not merge a genuine 11-digit non-NANP number with a 10-digit one', () => {
    // 11 digits but not starting with "1", so nothing is stripped → not a match
    expect(rule.validate(makeRows([{ Phone: '42898851714' }, { Phone: '2898851714' }]))).toHaveLength(0);
  });
});
