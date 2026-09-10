import { describe, expect, it } from 'vitest';
import { MissingContactRule } from '../../src/validators/customer/missingContact.rule';
import { InvalidEmailRule } from '../../src/validators/customer/invalidEmail.rule';
import { DuplicateEmailRule } from '../../src/validators/customer/duplicateEmail.rule';
import { makeRows } from '../helpers';

describe('MissingContactRule', () => {
  const rule = new MissingContactRule();

  it('flags a row where First/Last/Email/Phone are all blank', () => {
    const issues = rule.validate(makeRows([{ Email: '', Phone: '', 'First Name': '', 'Last Name': '' }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('Error');
    expect(issues[0].issueType).toBe('MissingContact');
  });

  it('passes when at least one identity field is present', () => {
    expect(rule.validate(makeRows([{ 'First Name': 'John' }]))).toHaveLength(0);
    expect(rule.validate(makeRows([{ Email: 'a@b.com' }]))).toHaveLength(0);
    expect(rule.validate(makeRows([{ Phone: '5551234567' }]))).toHaveLength(0);
  });

  it('treats whitespace-only fields as blank (normalized is trimmed)', () => {
    const issues = rule.validate(makeRows([{ 'First Name': '   ', Email: '  ' }]));
    expect(issues).toHaveLength(1);
  });
});

describe('InvalidEmailRule', () => {
  const rule = new InvalidEmailRule();

  it('flags malformed emails', () => {
    for (const bad of ['not-an-email', 'a@b', 'a@@b.com', 'foo@bar.', '@nodomain.com']) {
      const issues = rule.validate(makeRows([{ Email: bad }]));
      expect(issues, `expected "${bad}" to be flagged`).toHaveLength(1);
      expect(issues[0].issueType).toBe('InvalidEmail');
    }
  });

  it('accepts valid emails', () => {
    // An & in the local part: Shopify imported one; the old regex flagged it.
    for (const ok of ['user@example.com', 'a.b+tag@sub.example.co.uk', 'shop&co@example.org']) {
      expect(rule.validate(makeRows([{ Email: ok }])), `expected "${ok}" to pass`).toHaveLength(0);
    }
  });

  // Synthetic stand-ins for the malformed shapes the pre-check flagged in stored
  // runs: a bad TLD, a missing @, a non-email value, and a domain with no TLD.
  it('still flags the stored malformed email shapes', () => {
    for (const bad of ['someone@example.net.n7', 'someoneghotmail.com', 'they/them', 'someone@yahoo', 'someone@gmail']) {
      expect(rule.validate(makeRows([{ Email: bad }])), `expected "${bad}" to be flagged`).toHaveLength(1);
    }
  });

  it('ignores blank emails (that is MissingContactRule\'s job)', () => {
    expect(rule.validate(makeRows([{ Email: '' }]))).toHaveLength(0);
  });
});

describe('DuplicateEmailRule', () => {
  const rule = new DuplicateEmailRule();

  it('flags every row sharing an email, case-insensitively', () => {
    const issues = rule.validate(
      makeRows([{ Email: 'dup@x.com' }, { Email: 'unique@x.com' }, { Email: 'DUP@x.com' }]),
    );
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.issueType === 'DuplicateEmail')).toBe(true);
  });

  it('does not flag unique emails', () => {
    expect(rule.validate(makeRows([{ Email: 'a@x.com' }, { Email: 'b@x.com' }]))).toHaveLength(0);
  });

  it('ignores blank emails', () => {
    expect(rule.validate(makeRows([{ Email: '' }, { Email: '' }]))).toHaveLength(0);
  });
});
