import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { parseHistoryQuery } from '../src/utils/historyQuery';
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  clampHistoryLimit,
} from '../src/services/customerValidation.service';

// ─────────────────────────────────────────────────────────────────────────────
// THE HISTORY FILTER.
//
// It narrows a LIST. It grants nothing and denies nothing — every row is still
// readable by a request that omits the parameter, exactly as before.
//
// The two ways it can silently be useless:
//   1. Normalization drift. Rows store what the person typed ("Josh"), and the
//      filter supplies the lowercased comparison key from actorKey(). If the
//      database comparison is not case-insensitive, ?createdBy=Josh matches zero
//      rows while the page plainly shows runs by "Josh".
//   2. Widening on a miss. Asked for a narrower list and quietly handed back
//      everyone's is the failure that makes people stop trusting the control.
// ─────────────────────────────────────────────────────────────────────────────

function req(query: Record<string, string>, header?: string): Request {
  return {
    query,
    header: (name: string) =>
      name.toLowerCase() === 'x-qa-user' ? header : undefined,
  } as unknown as Request;
}

describe('parseHistoryQuery — who', () => {
  it('no createdBy means everyone (undefined, not a filter)', () => {
    expect(parseHistoryQuery(req({})).createdBy).toBeUndefined();
  });

  it('an empty createdBy also means everyone, not a match on ""', () => {
    expect(parseHistoryQuery(req({ createdBy: '' })).createdBy).toBeUndefined();
  });

  it('resolves "me" from the X-QA-User header', () => {
    expect(parseHistoryQuery(req({ createdBy: 'me' }, 'josh')).createdBy).toBe('josh');
  });

  it('reduces an explicit name to the lowercase comparison key', () => {
    // The row is stored as "Josh". The filter carries the key, and the query
    // matches case-insensitively -- otherwise this looks like "Josh has never
    // run anything".
    expect(parseHistoryQuery(req({ createdBy: 'Josh' })).createdBy).toBe('josh');
    expect(parseHistoryQuery(req({ createdBy: 'J O S H' })).createdBy).toBe('josh');
    expect(parseHistoryQuery(req({ createdBy: 'josh@example.com' })).createdBy).toBe(
      'joshexample.com',
    );
  });

  it('falls back to "unknown" — never to everyone — when self has no name', () => {
    // This browser never picked a name, so its rows were written as 'unknown'.
    // Widening to the whole team here would hand back the exact list the caller
    // just asked to be filtered out of.
    expect(parseHistoryQuery(req({ createdBy: 'me' }, undefined)).createdBy).toBe(
      'unknown',
    );
    expect(parseHistoryQuery(req({ createdBy: '!!!!' })).createdBy).toBe('unknown');
  });
});

describe('clampHistoryLimit — how many', () => {
  it('defaults when absent or unparseable', () => {
    expect(clampHistoryLimit(undefined)).toBe(HISTORY_DEFAULT_LIMIT);
    expect(clampHistoryLimit(Number('abc'))).toBe(HISTORY_DEFAULT_LIMIT);
    expect(clampHistoryLimit(Infinity)).toBe(HISTORY_DEFAULT_LIMIT);
  });

  it('caps so a hand-typed ?limit= cannot ask for the whole table', () => {
    expect(clampHistoryLimit(1_000_000)).toBe(HISTORY_MAX_LIMIT);
  });

  it('floors at 1 — zero or negative would return an empty page, not "no limit"', () => {
    expect(clampHistoryLimit(0)).toBe(1);
    expect(clampHistoryLimit(-5)).toBe(1);
  });

  it('passes a sane value through, truncating fractions', () => {
    expect(clampHistoryLimit(25)).toBe(25);
    expect(clampHistoryLimit(25.9)).toBe(25);
  });
});

describe('parseHistoryQuery — always returns a bounded limit', () => {
  it('bounds the query even when the caller sends none', () => {
    // The product history previously had NO take at all: every upload ever, by
    // anyone. The parser must never hand a service an unbounded query.
    expect(parseHistoryQuery(req({})).limit).toBe(HISTORY_DEFAULT_LIMIT);
    expect(parseHistoryQuery(req({ limit: '999999' })).limit).toBe(HISTORY_MAX_LIMIT);
    expect(parseHistoryQuery(req({ limit: 'nonsense' })).limit).toBe(
      HISTORY_DEFAULT_LIMIT,
    );
  });
});
