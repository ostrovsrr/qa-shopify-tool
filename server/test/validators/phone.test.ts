import { describe, expect, it } from 'vitest';
import { InvalidPhoneRule } from '../../src/validators/customer/invalidPhone.rule';
import { DuplicatePhoneRule } from '../../src/validators/customer/duplicatePhone.rule';
import { makeRows } from '../helpers';

describe('InvalidPhoneRule', () => {
  const rule = new InvalidPhoneRule();

  it('accepts well-formed 10–15 digit numbers', () => {
    for (const ok of ['5551234567', '+1 (555) 123-4567', '555.123.4567']) {
      expect(rule.validate(makeRows([{ Phone: ok }])), `expected "${ok}" to pass`).toHaveLength(0);
    }
  });

  it('errors on Excel scientific notation', () => {
    const issues = rule.validate(makeRows([{ Phone: '1.23456E+11' }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('Error');
    expect(issues[0].message).toContain('scientific notation');
  });

  it('warns on unexpected characters', () => {
    const issues = rule.validate(makeRows([{ Phone: '555-CALL-NOW' }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('Warning');
    expect(issues[0].issueType).toBe('SuspiciousPhoneCharacters');
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

  it('flags duplicates after stripping non-digits', () => {
    const issues = rule.validate(
      makeRows([{ Phone: '(555) 123-4567' }, { Phone: '5551234567' }, { Phone: '5559999999' }]),
    );
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.issueType === 'DuplicatePhone')).toBe(true);
  });

  it('does not flag distinct numbers', () => {
    expect(rule.validate(makeRows([{ Phone: '5551110000' }, { Phone: '5552220000' }]))).toHaveLength(0);
  });
});
