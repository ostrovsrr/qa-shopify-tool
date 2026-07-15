import { describe, expect, it } from 'vitest';
import {
  APPEND_TO_NOTE,
  APPEND_TO_TAGS,
  applyMappingToRecord,
  assertValidColumnMapping,
  KEEP_COLUMN,
  resolveMappingTarget,
  SHOPIFY_COLUMNS,
  suggestMapping,
} from '../src/services/columnMapping.service';

describe('applyMappingToRecord', () => {
  it('renames mapped keys and keeps unmapped keys as-is', () => {
    const out = applyMappingToRecord(
      { 'E-mail': 'a@x.com', Extra: 'kept' },
      { 'E-mail': 'Email' },
    );
    expect(out).toEqual({ Email: 'a@x.com', Extra: 'kept' });
  });

  it('appends a source column to Tags comma-separated after the mapped Tags value', () => {
    const out = applyMappingToRecord(
      { Tags: 'vip', Segment: 'wholesale' },
      { Tags: 'Tags', Segment: APPEND_TO_TAGS },
    );
    expect(out['Tags']).toBe('vip,wholesale');
    expect(out).not.toHaveProperty('Segment');
  });

  it('supports multiple Add to Tags sources in column order', () => {
    const out = applyMappingToRecord(
      { Segment: 'wholesale', Region: 'emea', Tags: 'vip' },
      { Tags: 'Tags', Segment: APPEND_TO_TAGS, Region: APPEND_TO_TAGS },
    );
    expect(out['Tags']).toBe('vip,wholesale,emea');
  });

  it('creates Tags when only append sources are mapped', () => {
    const out = applyMappingToRecord(
      { Segment: 'wholesale' },
      { Segment: APPEND_TO_TAGS },
    );
    expect(out['Tags']).toBe('wholesale');
  });

  it('skips empty append values (no dangling separators)', () => {
    const out = applyMappingToRecord(
      { Tags: 'vip', A: '', B: '  ', C: 'gold' },
      { Tags: 'Tags', A: APPEND_TO_TAGS, B: APPEND_TO_TAGS, C: APPEND_TO_TAGS },
    );
    expect(out['Tags']).toBe('vip,gold');
  });

  it('appends to Note with a " | " separator', () => {
    const out = applyMappingToRecord(
      { Note: 'base note', Source: 'legacy-crm', Owner: 'alice' },
      { Note: 'Note', Source: APPEND_TO_NOTE, Owner: APPEND_TO_NOTE },
    );
    expect(out['Note']).toBe('base note | legacy-crm | alice');
  });

  it('creates Note when only append sources are mapped', () => {
    const out = applyMappingToRecord({ Source: 'legacy-crm' }, { Source: APPEND_TO_NOTE });
    expect(out['Note']).toBe('legacy-crm');
  });

  it('keeps columns mapped to Keep under their original names', () => {
    const out = applyMappingToRecord(
      { 'E-mail': 'a@x.com', 'Loyalty Tier': 'gold', 'Member Since': '2019' },
      { 'E-mail': 'Email', 'Loyalty Tier': KEEP_COLUMN, 'Member Since': KEEP_COLUMN },
    );
    expect(out).toEqual({
      Email: 'a@x.com',
      'Loyalty Tier': 'gold',
      'Member Since': '2019',
    });
    expect(out).not.toHaveProperty('Keep');
  });
});

describe('mapping targets', () => {
  it('rejects two source columns mapped to one scalar Shopify field', () => {
    expect(() =>
      assertValidColumnMapping(['Email', 'Legacy Email'], {
        Email: 'Email',
        'Legacy Email': 'Email',
      }),
    ).toThrow(/avoid overwriting customer data/i);
  });

  it('allows multiple append and Keep directives', () => {
    expect(() =>
      assertValidColumnMapping(['Segment', 'Region', 'Legacy'], {
        Segment: APPEND_TO_TAGS,
        Region: APPEND_TO_TAGS,
        Legacy: KEEP_COLUMN,
      }),
    ).not.toThrow();
  });

  it('rejects unknown sources and targets supplied outside the mapping UI', () => {
    expect(() => assertValidColumnMapping(['Email'], { Missing: 'Email' })).toThrow(
      /unknown source column/i,
    );
    expect(() => assertValidColumnMapping(['Email'], { Email: '__proto__' })).toThrow(
      /not a valid column-mapping target/i,
    );
  });

  it('no longer offers read-only Total Spent / Total Orders', () => {
    expect(SHOPIFY_COLUMNS).not.toContain('Total Spent');
    expect(SHOPIFY_COLUMNS).not.toContain('Total Orders');
  });

  it('no longer suggests Total Spent / Total Orders for matching headers', () => {
    const suggested = suggestMapping(['Total Spent', 'Total Orders', 'Email']);
    expect(suggested).toEqual({ Email: 'Email' });
  });

  it('resolves append targets to their real Shopify columns', () => {
    expect(resolveMappingTarget(APPEND_TO_TAGS)).toBe('Tags');
    expect(resolveMappingTarget(APPEND_TO_NOTE)).toBe('Note');
    expect(resolveMappingTarget('Email')).toBe('Email');
  });
});
