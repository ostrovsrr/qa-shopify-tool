import { describe, expect, it } from 'vitest';
import { actorKey, normalizeActor } from '../src/services/actionLog.service';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/instance serves the DEFAULT display name for the instance, so that a
// colleague does not have to type their own name into every browser they open.
//
// TWO FORMS, ON PURPOSE:
//
//   normalizeActor()  what gets STORED and SHOWN — "Josh". Case preserved,
//                     because the history reads "by Josh", not "by josh".
//   actorKey()        what gets COMPARED — "josh". Case folded, because a person
//                     who typed "josh" one day and "Josh" the next is one person.
//
// The trap this file exists for: lowercasing on the way in would make the display
// name a casualty of the lookup, and matching case-sensitively would split one
// colleague into three. Store what they typed; match without regard to case — and
// the database comparison must be case-insensitive to agree (see the history
// services' `mode: 'insensitive'`).
//
// It remains a LABEL, NOT A LOGIN. Serving it from the server makes it consistent,
// never trustworthy: the client can still send any name, and nothing is gated on it.
// ─────────────────────────────────────────────────────────────────────────────

/** Exactly what the route does with QA_INSTANCE_OWNER. */
function ownerFromEnv(raw: string | undefined): string | null {
  const owner = normalizeActor(raw ?? '');
  return owner || null;
}

describe('instance owner default', () => {
  it('is null when unset, so the badge starts empty as it always did', () => {
    expect(ownerFromEnv(undefined)).toBeNull();
    expect(ownerFromEnv('')).toBeNull();
  });

  it('is null when the value normalises away to nothing', () => {
    // Somebody pastes a placeholder like "<name>" — that must not become a
    // meaningless label on every destructive action this instance logs.
    expect(ownerFromEnv('<>')).toBeNull();
    expect(ownerFromEnv('   ')).toBeNull();
  });

  it('PRESERVES capitalisation, because this name is displayed', () => {
    // deploy/.env says QA_OWNER_SE5=Josh, and the header badge and the history
    // both have to read "Josh". Lowercasing here is what this test forbids.
    expect(ownerFromEnv('Josh')).toBe('Josh');
    expect(ownerFromEnv('Alimrani')).toBe('Alimrani');
    expect(ownerFromEnv('Luigi')).toBe('Luigi');
  });

  it('still strips characters the filter would never match', () => {
    expect(ownerFromEnv('Raiya Patel')).toBe('RaiyaPatel');
    expect(ownerFromEnv('pratha@example.com')).toBe('prathaexample.com');
  });

  it('truncates to the same 60-character ceiling as the header', () => {
    expect(ownerFromEnv('a'.repeat(200))).toHaveLength(60);
  });
});

describe('actorKey — the comparison form', () => {
  it('folds case so one person is one person', () => {
    expect(actorKey('Josh')).toBe('josh');
    expect(actorKey('josh')).toBe('josh');
    expect(actorKey('JOSH')).toBe('josh');
  });

  it('agrees with the stored form once case is folded', () => {
    // The invariant the history filter depends on: whatever the writer stored,
    // lowercasing it must produce exactly what the filter searches for.
    for (const name of ['Rodion', 'Raiya', 'Kashif', 'Alimrani', 'Josh', 'Mandy', 'Pratha', 'Luigi']) {
      expect(normalizeActor(name).toLowerCase()).toBe(actorKey(name));
    }
  });
});
