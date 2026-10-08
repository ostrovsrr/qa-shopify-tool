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

  // Every case below is one the 2026-09-10 test-store probe settled.
  it('accepts valid emails', () => {
    for (const ok of [
      'user@example.com',
      'a.b+tag@sub.example.co.uk',
      'shop&co@example.org',
      "o'probe@example.com",
      'qa!probe@example.com',
      'qapröbe@example.com',
      'qaprobe@bücher-example.com',
      'user@example.c', // one-letter TLD
      ...['#', '$', '*', '/', '=', '?', '^', '`', '{', '|', '}', '~'].map((ch) => `qa${ch}probe@example.com`),
      `${'a'.repeat(129)}@example.com`, // Shopify's local-part maximum
    ]) {
      expect(rule.validate(makeRows([{ Email: ok }])), `expected "${ok}" to pass`).toHaveLength(0);
    }
  });

  it('flags the dot and length shapes Shopify rejected', () => {
    for (const bad of [
      'qa..probe@example.com',
      '.qaprobe@example.com',
      'qaprobe.@example.com',
      `${'a'.repeat(130)}@example.com`, // local part one over Shopify's 129
      `qaprobe@${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(60)}.com`, // > 255
    ]) {
      expect(rule.validate(makeRows([{ Email: bad }])), `expected "${bad}" to be flagged`).toHaveLength(1);
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

  // Shopify keeps one customer per email (the probe accepted the first row and
  // rejected the repeat as "already been taken"), so only the repeat is flagged.
  it('flags every repeat of an email after the first, case-insensitively', () => {
    const issues = rule.validate(
      makeRows([{ Email: 'dup@x.com' }, { Email: 'unique@x.com' }, { Email: 'DUP@x.com' }, { Email: 'Dup@X.com' }]),
    );
    expect(issues.map((i) => i.rowNumber)).toEqual([4, 5]);
    expect(issues.every((i) => i.issueType === 'DuplicateEmail')).toBe(true);
  });

  it('does not flag unique emails', () => {
    expect(rule.validate(makeRows([{ Email: 'a@x.com' }, { Email: 'b@x.com' }]))).toHaveLength(0);
  });

  it('ignores blank emails', () => {
    expect(rule.validate(makeRows([{ Email: '' }, { Email: '' }]))).toHaveLength(0);
  });

  it('lists every row of a small group', () => {
    const issues = rule.validate(makeRows([{ Email: 'dup@x.com' }, { Email: 'dup@x.com' }, { Email: 'dup@x.com' }]));
    expect(issues[0].message).toContain('appears in 3 rows: 2, 3, 4.');
  });

  // Each repeat gets its own issue, so listing the whole group in every message was
  // quadratic: 20k rows on one placeholder email meant gigabytes of message text.
  it('caps the rows listed for a large group, so message size does not grow with it', () => {
    const issues = rule.validate(makeRows(Array.from({ length: 5000 }, () => ({ Email: 'none@x.com' }))));
    expect(issues).toHaveLength(4999);
    expect(issues[0].message).toContain('appears in 5,000 rows: 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 4,990 more.');
    expect(Math.max(...issues.map((i) => i.message.length))).toBeLessThan(300);
  });
});
