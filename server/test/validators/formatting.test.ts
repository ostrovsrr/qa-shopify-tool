import { describe, expect, it } from 'vitest';
import { TagsRule } from '../../src/validators/customer/tags.rule';
import { NumericFieldsRule } from '../../src/validators/customer/numericFields.rule';
import { HtmlInjectionRule } from '../../src/validators/customer/htmlInjection.rule';
import { LongNoteRule } from '../../src/validators/customer/longNote.rule';
import { countByType, makeRows } from '../helpers';

describe('TagsRule', () => {
  const rule = new TagsRule();

  it('accepts a clean tag list', () => {
    expect(rule.validate(makeRows([{ Tags: 'vip, wholesale, newsletter' }]))).toHaveLength(0);
  });

  it('flags consecutive, leading/trailing, empty, and duplicate tags', () => {
    expect(rule.validate(makeRows([{ Tags: 'a,,b' }]))[0].issueType).toBe('DuplicateCommasInTags');
    expect(rule.validate(makeRows([{ Tags: ',a,b' }]))[0].issueType).toBe('TagsStartsOrEndsWithComma');
    expect(rule.validate(makeRows([{ Tags: 'a, ,b' }])).some((i) => i.issueType === 'EmptyTagValues')).toBe(true);
    expect(rule.validate(makeRows([{ Tags: 'vip, VIP' }]))[0].issueType).toBe('DuplicateTags');
  });

  it('errors when a single tag exceeds 255 characters', () => {
    const issues = rule.validate(makeRows([{ Tags: 'x'.repeat(256) }]));
    expect(issues.some((i) => i.issueType === 'TagTooLong')).toBe(true);
  });
});

describe('NumericFieldsRule', () => {
  const rule = new NumericFieldsRule();

  it('accepts valid non-negative numbers', () => {
    expect(rule.validate(makeRows([{ 'Total Spent': '199.99', 'Total Orders': '3' }]))).toHaveLength(0);
  });

  it('warns on non-numeric and negative values', () => {
    expect(rule.validate(makeRows([{ 'Total Spent': 'abc' }]))[0].issueType).toBe('NonNumericField');
    expect(rule.validate(makeRows([{ 'Total Orders': '-1' }]))[0].issueType).toBe('NegativeNumericField');
  });
});

describe('HtmlInjectionRule', () => {
  const rule = new HtmlInjectionRule();

  it('errors on HTML tags in checked fields', () => {
    const issues = rule.validate(makeRows([{ Note: 'Hello <script>alert(1)</script>' }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('Error');
    expect(issues[0].issueType).toBe('HtmlInjection');
  });

  it('leaves plain text alone', () => {
    expect(rule.validate(makeRows([{ Note: 'Loyal customer since 2019' }]))).toHaveLength(0);
  });
});

describe('LongNoteRule', () => {
  const rule = new LongNoteRule();

  it('warns when the note exceeds 500 characters', () => {
    const issues = rule.validate(makeRows([{ Note: 'x'.repeat(501) }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe('LongNote');
  });

  it('passes a short note', () => {
    expect(rule.validate(makeRows([{ Note: 'x'.repeat(500) }]))).toHaveLength(0);
  });
});

// Guards against a subtle bug class: a rule mutating shared state across rows.
describe('rules are pure across multiple rows', () => {
  it('NumericFieldsRule keeps rows independent', () => {
    const rule = new NumericFieldsRule();
    const issues = rule.validate(makeRows([{ 'Total Spent': '10' }, { 'Total Spent': 'bad' }, { 'Total Spent': '20' }]));
    expect(countByType(issues)).toEqual({ NonNumericField: 1 });
    expect(issues[0].rowNumber).toBe(3);
  });
});
