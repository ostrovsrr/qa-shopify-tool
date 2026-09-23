import { describe, expect, it } from 'vitest';
import { buildValidationOutcome } from '../src/services/customerValidation.service';
import { makeRows } from './helpers';

const BOTH = { moveInvalidContactToNotes: true, fillMissingContactName: true };

describe('validation summary', () => {
  // The property the whole summary rests on. If these stop summing, something is
  // being counted twice and every number on the screen becomes untrustworthy.
  const sums = (s: { totalRows: number; ready: number; fixed: number; blocked: number; removed: number }) =>
    s.ready + s.fixed + s.blocked + s.removed === s.totalRows;

  it('buckets sum to totalRows on a clean file', () => {
    const { summary } = buildValidationOutcome(
      makeRows([{ 'First Name': 'Ann', Email: 'ann@example.com' }]),
      {},
    );
    expect(sums(summary)).toBe(true);
    expect(summary).toMatchObject({ totalRows: 1, ready: 1, fixed: 0, blocked: 0, removed: 0 });
  });

  it('buckets sum with every option firing at once', () => {
    const { summary } = buildValidationOutcome(
      makeRows([
        { 'First Name': 'Ann', Email: 'ann@example.com' }, // ready
        { 'First Name': 'Bad', Email: 'qa..probe@example.com' }, // fixed (invalid)
        { 'Default Address City': 'Toronto' }, // fixed (named)
        { 'First Name': 'X', 'Default Address Country Code': 'NOPE' }, // blocked
        { 'First Name': '', Email: '' }, // removed (blank)
      ]),
      {},
      BOTH,
    );
    expect(sums(summary)).toBe(true);
    expect(summary).toMatchObject({
      totalRows: 5,
      ready: 1,
      fixed: 2,
      blocked: 1,
      removed: 1,
      removedBlank: 1,
    });
  });

  // BLOCKED WINS: the tool moved this row's email, but its country code is still
  // wrong, so it is not importable and must not be advertised as fixed.
  it('counts a row that was fixed but still fails as blocked only', () => {
    const { summary } = buildValidationOutcome(
      makeRows([
        {
          'First Name': 'Ann',
          Email: 'qa..probe@example.com',
          'Default Address Country Code': 'NOPE',
        },
      ]),
      {},
      BOTH,
    );
    expect(sums(summary)).toBe(true);
    expect(summary).toMatchObject({ blocked: 1, fixed: 0, fixedInvalidContact: 0 });
  });

  // One row, two fixes: counted ONCE in `fixed`, but in both breakdown lines.
  // The breakdown is allowed to exceed the bucket; the bucket is not allowed to
  // exceed reality.
  it('counts a row fixed two ways once in the bucket, twice in the breakdown', () => {
    const { summary } = buildValidationOutcome(
      makeRows([{ Email: 'qa..probe@example.com', 'Default Address City': 'Toronto' }]),
      {},
      BOTH,
    );
    expect(summary).toMatchObject({
      fixed: 1,
      fixedInvalidContact: 1,
      fixedNamed: 1,
    });
    expect(sums(summary)).toBe(true);
  });

  // Duplicates cut ACROSS the buckets, so they are reported separately. Counts
  // the repeats Shopify would reject, never the keeper.
  it('counts duplicate repeats, not keepers, and names the overlap', () => {
    const rows = makeRows([
      { 'First Name': 'A', Email: 'dup@x.com', Phone: '+1 613 555 0104' },
      { 'First Name': 'B', Email: 'dup@x.com', Phone: '+1 613 555 0104' },
      { 'First Name': 'C', Email: 'other@x.com', Phone: '+1 613 555 0155' },
    ]);
    const { summary } = buildValidationOutcome(rows, {}, { moveDuplicatesToNotes: true });
    // Three rows, one repeat — the keeper is not a duplicate.
    expect(summary.duplicateRecords).toBe(1);
    expect(summary.duplicateEmail).toBe(1);
    expect(summary.duplicatePhone).toBe(1);
    // Same row on both, which is why email + phone > duplicateRecords.
    expect(summary.duplicateBoth).toBe(1);
    expect(summary.fixedDuplicates).toBe(1);
    expect(sums(summary)).toBe(true);
  });

  it('reports duplicates as blocked, not fixed, when the option is off', () => {
    const rows = makeRows([
      { 'First Name': 'A', Email: 'dup@x.com' },
      { 'First Name': 'B', Email: 'dup@x.com' },
    ]);
    const { summary } = buildValidationOutcome(rows, {});
    expect(summary).toMatchObject({ duplicateRecords: 1, fixedDuplicates: 0, blocked: 1 });
    expect(sums(summary)).toBe(true);
  });

  it('counts errors and blocked records separately', () => {
    // One row, two errors.
    const { summary } = buildValidationOutcome(
      makeRows([{ 'First Name': 'A', Email: 'qa..probe@example.com', Phone: '555-555-5555' }]),
      {},
    );
    expect(summary.blocked).toBe(1);
    expect(summary.errorCount).toBe(2);
  });
});
