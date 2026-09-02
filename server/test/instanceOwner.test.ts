import { describe, expect, it } from 'vitest';
import { normalizeActor } from '../src/services/actionLog.service';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/instance serves the DEFAULT display name for the instance, so that a
// colleague does not have to type their own name into every browser they open.
//
// The whole value of the default is that it is CONSISTENT: it lands in the action
// log next to destructive actions, and the history filter looks names up by the
// normalised form. A default the writer stores as "Joshua" while the filter searches
// for "joshua" would quietly match nothing — so the route must normalise the
// environment variable with exactly the function the writer uses, not trust that
// whoever edited deploy/.env typed a clean slug.
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

  it('normalises the way the action log writer does', () => {
    // The case that matters: deploy/.env says "Joshua", the log stores "joshua",
    // and ?createdBy=joshua has to find it.
    expect(ownerFromEnv('Joshua')).toBe('joshua');
    expect(ownerFromEnv('Ali')).toBe('ali');
  });

  it('strips characters the history filter would never match', () => {
    expect(ownerFromEnv('Raiya Patel')).toBe('raiyapatel');
    expect(ownerFromEnv('pratha@example.com')).toBe('prathaexample.com');
  });

  it('truncates to the same 60-character ceiling as the header', () => {
    expect(ownerFromEnv('a'.repeat(200))).toHaveLength(60);
  });
});
