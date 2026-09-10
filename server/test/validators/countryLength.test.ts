import { describe, expect, it } from 'vitest';
import { CountryCodeRule } from '../../src/validators/customer/countryCode.rule';
import { FieldLengthRule } from '../../src/validators/customer/fieldLength.rule';
import { makeRows } from '../helpers';

// Both rules come from the 2026-09-10 synthetic probe into a test store.
describe('CountryCodeRule', () => {
  const rule = new CountryCodeRule();

  it('flags values that are not a Shopify country code', () => {
    for (const bad of ['USA', 'United States', 'XX', 'PR']) {
      const issues = rule.validate(makeRows([{ 'Default Address Country Code': bad }]));
      expect(issues, bad).toHaveLength(1);
      expect(issues[0].issueType).toBe('InvalidCountryCode');
    }
  });

  it('accepts ISO alpha-2 codes in any case, and a blank', () => {
    for (const ok of ['US', 'ca', 'Gb', 'ZZ', '']) {
      expect(rule.validate(makeRows([{ 'Default Address Country Code': ok }])), ok).toHaveLength(0);
    }
  });
});

describe('FieldLengthRule', () => {
  const rule = new FieldLengthRule();

  it('flags a field one character over its limit and passes it at the limit', () => {
    for (const [field, max] of [['First Name', 255], ['Last Name', 255], ['Note', 5000], ['Default Address City', 255]] as const) {
      expect(rule.validate(makeRows([{ [field]: 'x'.repeat(max) }])), `${field} at ${max}`).toHaveLength(0);
      const issues = rule.validate(makeRows([{ [field]: 'x'.repeat(max + 1) }]));
      expect(issues, `${field} at ${max + 1}`).toHaveLength(1);
      expect(issues[0]).toMatchObject({ column: field, issueType: 'FieldTooLong' });
    }
  });

  it('counts characters, not UTF-16 units', () => {
    // 200 emoji = 400 UTF-16 code units but 200 characters.
    expect(rule.validate(makeRows([{ 'First Name': '😀'.repeat(200) }]))).toHaveLength(0);
  });
});
