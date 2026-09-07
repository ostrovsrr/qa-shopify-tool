import { describe, expect, it } from 'vitest';
import { buildTemplateDataset } from '../src/reports/templateDataset';

// Regression: ISSUE-003 — the HeliosMigrated option appended the tag even when
// the CSV already carried it, so re-validating an already-migrated export wrote
// "Individual,HeliosMigrated,HeliosMigrated" into the Shopify Template sheet.
// Found by /qa on 2026-09-07
// Report: .gstack/qa-reports/qa-report-localhost-3101-2026-09-07.md
function orig(rowNumber: number, data: Record<string, string>) {
  return { rowNumber, data };
}

describe('buildTemplateDataset — HeliosMigrated tag', () => {
  it('does not re-add the tag when the CSV row already carries it', () => {
    const { rows } = buildTemplateDataset({
      originalRows: [orig(2, { 'First Name': 'A', Tags: 'Individual,HeliosMigrated' })],
      heliosMigratedTag: true,
    });
    expect(rows[0].record['Tags']).toBe('Individual,HeliosMigrated');
  });

  it('matches the existing tag case-insensitively and ignores surrounding spaces', () => {
    const { rows } = buildTemplateDataset({
      originalRows: [
        orig(2, { 'First Name': 'A', Tags: 'Individual, heliosmigrated' }),
        orig(3, { 'First Name': 'B', Tags: 'HELIOSMIGRATED' }),
      ],
      heliosMigratedTag: true,
    });
    expect(rows[0].record['Tags']).toBe('Individual, heliosmigrated');
    expect(rows[1].record['Tags']).toBe('HELIOSMIGRATED');
  });

  it('still appends the tag when the row has other tags but not this one', () => {
    const { rows } = buildTemplateDataset({
      originalRows: [orig(2, { 'First Name': 'A', Tags: 'Individual' })],
      heliosMigratedTag: true,
    });
    expect(rows[0].record['Tags']).toBe('Individual,HeliosMigrated');
  });

  it('still sets the tag on a row with no tags at all', () => {
    const { rows } = buildTemplateDataset({
      originalRows: [orig(2, { 'First Name': 'A', Tags: '' }), orig(3, { 'First Name': 'B' })],
      heliosMigratedTag: true,
    });
    expect(rows[0].record['Tags']).toBe('HeliosMigrated');
    expect(rows[1].record['Tags']).toBe('HeliosMigrated');
  });

  it('does not add the tag at all when the option is off', () => {
    const { rows } = buildTemplateDataset({
      originalRows: [orig(2, { 'First Name': 'A', Tags: 'Individual' })],
    });
    expect(rows[0].record['Tags']).toBe('Individual');
  });

  // A tag whose name merely contains HeliosMigrated is a different tag.
  it('treats a longer tag containing the name as a different tag', () => {
    const { rows } = buildTemplateDataset({
      originalRows: [orig(2, { 'First Name': 'A', Tags: 'HeliosMigratedV2' })],
      heliosMigratedTag: true,
    });
    expect(rows[0].record['Tags']).toBe('HeliosMigratedV2,HeliosMigrated');
  });
});
