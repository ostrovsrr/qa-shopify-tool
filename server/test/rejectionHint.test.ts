import { describe, expect, it } from 'vitest';
import { hintFor } from '../src/services/productFeedback.service';

// Regression: ISSUE-004 — importing the documented sample_products.csv returned
// 0 accepted / 3 rejected, two of them reading "Type can't be blank" against
// products whose Type column was plainly filled in. The complaint is about a
// missing metafield DEFINITION, not the Type column.
// Found by /qa on 2026-09-04
// Report: .gstack/qa-reports/qa-report-localhost-2026-09-04.md

describe('rejection hints', () => {
  it('explains the metafield rejection that reads like a Type column error', () => {
    const hint = hintFor('type', 'INVALID_METAFIELD');
    expect(hint).toMatch(/metafield definition/i);
    expect(hint).toMatch(/not the product's Type column/i);
  });

  it('leaves a genuine rejection to speak for itself', () => {
    expect(hintFor('price', 'INVALID_VARIANT')).toBeNull();
  });

  it('does not fire on a metafield code against some other field', () => {
    expect(hintFor('title', 'INVALID_METAFIELD')).toBeNull();
  });

  it('still fires when Shopify reports no field at all', () => {
    expect(hintFor(null, 'INVALID_METAFIELD')).not.toBeNull();
  });

  it('is case-insensitive on the field name', () => {
    expect(hintFor('Type', 'INVALID_METAFIELD')).not.toBeNull();
  });

  it('returns null when there is no code', () => {
    expect(hintFor('type', null)).toBeNull();
  });
});
