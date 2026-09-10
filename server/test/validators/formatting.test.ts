import { describe, expect, it } from 'vitest';
import { TagsRule } from '../../src/validators/customer/tags.rule';
import { HtmlInjectionRule } from '../../src/validators/customer/htmlInjection.rule';
import { countByType, makeRows } from '../helpers';

describe('TagsRule', () => {
  const rule = new TagsRule();

  it('accepts a clean tag list', () => {
    expect(rule.validate(makeRows([{ Tags: 'vip, wholesale, newsletter' }]))).toHaveLength(0);
  });

  // Tag hygiene used to be warned about. Shopify imports all of it, so it isn't
  // flagged any more — only the two hard limits below are.
  it('says nothing about messy but importable tag lists', () => {
    for (const tags of ['a,,b', ',a,b', 'a, ,b', 'vip, VIP']) {
      expect(rule.validate(makeRows([{ Tags: tags }])), `expected "${tags}" to pass`).toHaveLength(0);
    }
  });

  it('errors when a single tag exceeds 255 characters', () => {
    const issues = rule.validate(makeRows([{ Tags: 'x'.repeat(256) }]));
    expect(issues.some((i) => i.issueType === 'TagTooLong')).toBe(true);
  });

  it('errors when there are more than 250 tags', () => {
    const tags = Array.from({ length: 251 }, (_, i) => `t${i}`).join(',');
    const issues = rule.validate(makeRows([{ Tags: tags }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe('TooManyTags');
  });
});

describe('HtmlInjectionRule', () => {
  const rule = new HtmlInjectionRule();

  // The 2026-09-10 probe: HTML in First Name and Company was rejected ("cannot contain
  // HTML tags"); HTML in Note was imported.
  it('errors on HTML tags in checked fields', () => {
    for (const field of ['First Name', 'Default Address Company']) {
      const issues = rule.validate(makeRows([{ [field]: '<b>Bo</b>' }]));
      expect(issues, field).toHaveLength(1);
      expect(issues[0].severity).toBe('Error');
      expect(issues[0].issueType).toBe('HtmlInjection');
    }
  });

  it('does not check Note, which Shopify imports with HTML', () => {
    expect(rule.validate(makeRows([{ Note: 'Hello <p>there</p>' }]))).toHaveLength(0);
  });

  it('leaves plain text alone', () => {
    expect(rule.validate(makeRows([{ Note: 'Loyal customer since 2019' }]))).toHaveLength(0);
  });
});

// Guards against a subtle bug class: a rule mutating shared state across rows.
describe('rules are pure across multiple rows', () => {
  it('TagsRule keeps rows independent', () => {
    const rule = new TagsRule();
    const issues = rule.validate(
      makeRows([{ Tags: 'ok' }, { Tags: 'x'.repeat(256) }, { Tags: 'also-ok' }]),
    );
    expect(countByType(issues)).toEqual({ TagTooLong: 1 });
    expect(issues[0].rowNumber).toBe(3);
  });
});
