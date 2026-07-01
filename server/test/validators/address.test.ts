import { describe, expect, it } from 'vitest';
import { AddressCompletenessRule } from '../../src/validators/customer/addressCompleteness.rule';
import { PostalCodeRule } from '../../src/validators/customer/postalCode.rule';
import { ProvinceCodeRule } from '../../src/validators/customer/provinceCode.rule';
import { countByType, makeRows } from '../helpers';

describe('AddressCompletenessRule', () => {
  const rule = new AddressCompletenessRule();

  it('does nothing when there is no address at all', () => {
    expect(rule.validate(makeRows([{ 'First Name': 'John' }]))).toHaveLength(0);
  });

  it('warns on missing city/province for a partial North American address', () => {
    const issues = rule.validate(
      makeRows([{ 'Default Address Address1': '1 Main St', 'Default Address Country Code': 'CA' }]),
    );
    const byType = countByType(issues);
    expect(byType.MissingCity).toBe(1);
    expect(byType.MissingProvince).toBe(1);
  });

  it('escalates to Error when a province is present but country is missing', () => {
    const issues = rule.validate(
      makeRows([{ 'Default Address Address1': '1 Main St', 'Default Address Province Code': 'ON', 'Default Address City': 'Toronto' }]),
    );
    const missingCountry = issues.find((i) => i.issueType === 'MissingCountry');
    expect(missingCountry?.severity).toBe('Error');
  });

  it('warns when other address fields exist but Address1 (street) is missing', () => {
    const issues = rule.validate(
      makeRows([{ 'Default Address City': 'Toronto', 'Default Address Country Code': 'CA', 'Default Address Province Code': 'ON' }]),
    );
    expect(issues.some((i) => i.issueType === 'MissingAddress1')).toBe(true);
  });
});

describe('PostalCodeRule', () => {
  const rule = new PostalCodeRule();

  it('accepts valid CA and US codes', () => {
    expect(rule.validate(makeRows([{ 'Default Address Country Code': 'CA', 'Default Address Zip': 'M5V 3L9' }]))).toHaveLength(0);
    expect(rule.validate(makeRows([{ 'Default Address Country Code': 'US', 'Default Address Zip': '12345-6789' }]))).toHaveLength(0);
  });

  it('warns on malformed CA and US codes', () => {
    expect(rule.validate(makeRows([{ 'Default Address Country Code': 'CA', 'Default Address Zip': '90210' }]))[0].issueType).toBe('InvalidCanadianPostalCode');
    expect(rule.validate(makeRows([{ 'Default Address Country Code': 'US', 'Default Address Zip': 'M5V 3L9' }]))[0].issueType).toBe('InvalidUSZipCode');
  });

  it('skips validation for other countries and blank zips', () => {
    expect(rule.validate(makeRows([{ 'Default Address Country Code': 'GB', 'Default Address Zip': 'SW1A 1AA' }]))).toHaveLength(0);
    expect(rule.validate(makeRows([{ 'Default Address Country Code': 'CA', 'Default Address Zip': '' }]))).toHaveLength(0);
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
