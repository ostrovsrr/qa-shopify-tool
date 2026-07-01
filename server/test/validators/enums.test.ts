import { describe, expect, it } from 'vitest';
import { MarketingConsentRule } from '../../src/validators/customer/marketingConsent.rule';
import { TaxExemptRule } from '../../src/validators/customer/taxExempt.rule';
import { makeRows } from '../helpers';

describe('MarketingConsentRule', () => {
  const rule = new MarketingConsentRule();

  it('accepts the allowed boolean-ish values (case-insensitive) and blanks', () => {
    for (const ok of ['TRUE', 'false', 'Yes', 'no', '1', '0', '']) {
      const issues = rule.validate(makeRows([{ 'Accepts Email Marketing': ok, 'Accepts SMS Marketing': ok }]));
      expect(issues, `expected "${ok}" to pass`).toHaveLength(0);
    }
  });

  it('flags invalid values on both consent columns', () => {
    const issues = rule.validate(
      makeRows([{ 'Accepts Email Marketing': 'maybe', 'Accepts SMS Marketing': 'sometimes' }]),
    );
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.issueType === 'InvalidMarketingConsent')).toBe(true);
  });
});

describe('TaxExemptRule', () => {
  const rule = new TaxExemptRule();

  it('accepts allowed values and blanks', () => {
    for (const ok of ['TRUE', 'false', 'yes', 'NO', '1', '0', '']) {
      expect(rule.validate(makeRows([{ 'Tax Exempt': ok }])), `expected "${ok}" to pass`).toHaveLength(0);
    }
  });

  it('flags invalid values', () => {
    const issues = rule.validate(makeRows([{ 'Tax Exempt': 'exempt' }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe('InvalidTaxExempt');
  });
});
