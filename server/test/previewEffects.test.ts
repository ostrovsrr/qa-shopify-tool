import { describe, expect, it } from 'vitest';
import { PREVIEWABLE_FLAGS } from '../src/services/customerValidation.service';
import { buildValidationOutcome } from '../src/services/customerValidation.service';
import { makeRows } from './helpers';

// previewFlagEffects itself needs a preview entry on disk, so the HTTP-level
// behaviour is covered by the integration suite. What is worth pinning here is
// the arithmetic the UI does with the result: each option's "+N rows" is the
// difference in (ready + fixed) between the flag on and off.
const importable = (s: { ready: number; fixed: number }) => s.ready + s.fixed;

describe('per-option effect arithmetic', () => {
  const rows = () =>
    makeRows([
      { 'First Name': 'Ann', Email: 'ann@example.com' }, // fine either way
      { 'First Name': 'Bad', Email: 'qa..probe@example.com' }, // needs the invalid fix
      { 'Default Address City': 'Toronto' }, // needs the naming fix
      { 'First Name': '', Email: '' }, // blank
      // Same email AND matching name, so BOTH duplicate options have something
      // to do: merge absorbs one, move-to-Note rescues one.
      { 'First Name': 'Dup', 'Last Name': 'Same', Email: 'dup@x.com' },
      { 'First Name': 'Dup', 'Last Name': 'Same', Email: 'dup@x.com' },
    ]);

  it('moveInvalidContactToNotes turns a blocked row into an importable one', () => {
    const off = buildValidationOutcome(rows(), {}).summary;
    const on = buildValidationOutcome(rows(), {}, { moveInvalidContactToNotes: true }).summary;
    expect(importable(on) - importable(off)).toBe(1);
  });

  it('fillMissingContactName gains the data row and removes the blank one', () => {
    const off = buildValidationOutcome(rows(), {}).summary;
    const on = buildValidationOutcome(rows(), {}, { fillMissingContactName: true }).summary;
    expect(importable(on) - importable(off)).toBe(1);
    expect(on.removed - off.removed).toBe(1);
  });

  // The panel shows no figure for tagging, because it changes nobody's fate.
  it('heliosMigratedTag is not previewable and changes no outcome', () => {
    expect(PREVIEWABLE_FLAGS).not.toContain('heliosMigratedTag');
    const off = buildValidationOutcome(rows(), {}).summary;
    const on = buildValidationOutcome(rows(), {}, { heliosMigratedTag: true }).summary;
    expect(importable(on)).toBe(importable(off));
  });

  it('every previewable flag is one the dataset actually reads', () => {
    // A flag listed here but ignored by buildTemplateDataset would show a
    // permanent "+0 rows" and quietly lie about having no effect.
    for (const flag of PREVIEWABLE_FLAGS) {
      const off = buildValidationOutcome(rows(), {}).summary;
      const on = buildValidationOutcome(rows(), {}, { [flag]: true }).summary;
      const changed =
        importable(on) !== importable(off) ||
        on.removed !== off.removed ||
        on.blocked !== off.blocked ||
        on.fixed !== off.fixed;
      expect(on.ready + on.fixed + on.blocked + on.removed).toBe(on.totalRows);
      expect(changed, `${flag} had no effect on the fixture`).toBe(true);
    }
  });
});
