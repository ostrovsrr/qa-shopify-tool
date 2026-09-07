import { describe, expect, it } from 'vitest';
import { AddressCompletenessRule } from '../../src/validators/customer/addressCompleteness.rule';
import { ProvinceCodeRule } from '../../src/validators/customer/provinceCode.rule';
import { makeRows } from '../helpers';

describe('AddressCompletenessRule', () => {
  const rule = new AddressCompletenessRule();

  it('does nothing when there is no address at all', () => {
    expect(rule.validate(makeRows([{ 'First Name': 'John' }]))).toHaveLength(0);
  });

  it('errors when a province is present but country is missing', () => {
    const issues = rule.validate(
      makeRows([{ 'Default Address Address1': '1 Main St', 'Default Address Province Code': 'ON', 'Default Address City': 'Toronto' }]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe('MissingCountry');
    expect(issues[0].severity).toBe('Error');
  });

  // These used to be warnings. Shopify imports them (or rejects them at import),
  // so the pre-check stays quiet.
  it('says nothing about a partial address that Shopify still accepts', () => {
    expect(
      rule.validate(makeRows([{ 'Default Address Address1': '1 Main St', 'Default Address Country Code': 'CA' }])),
    ).toHaveLength(0);
    expect(
      rule.validate(makeRows([{ 'Default Address City': 'Toronto', 'Default Address Country Code': 'CA', 'Default Address Province Code': 'ON' }])),
    ).toHaveLength(0);
    expect(
      rule.validate(makeRows([{ 'Default Address Address1': '1 Main St', 'Default Address Country Code': 'CA', 'Default Address Phone': 'call me' }])),
    ).toHaveLength(0);
  });
});

describe('ProvinceCodeRule', () => {
  const rule = new ProvinceCodeRule();

  it('accepts valid province/state codes', () => {
    expect(rule.validate(makeRows([{ 'Default Address Country Code': 'CA', 'Default Address Province Code': 'ON' }]))).toHaveLength(0);
    expect(rule.validate(makeRows([{ 'Default Address Country Code': 'US', 'Default Address Province Code': 'ca' }]))).toHaveLength(0);
  });

  it('errors on an invalid province for the given country', () => {
    const issues = rule.validate(makeRows([{ 'Default Address Country Code': 'CA', 'Default Address Province Code': 'XX' }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('Error');
    expect(issues[0].issueType).toBe('InvalidProvinceCode');
  });

  it('skips when province or country is blank', () => {
    expect(rule.validate(makeRows([{ 'Default Address Country Code': 'CA', 'Default Address Province Code': '' }]))).toHaveLength(0);
    expect(rule.validate(makeRows([{ 'Default Address Province Code': 'ON' }]))).toHaveLength(0);
  });
});
