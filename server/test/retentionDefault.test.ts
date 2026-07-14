import { afterEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// THE TEST THAT WOULD HAVE PREVENTED IT.
//
// RETENTION_DAYS used to default to 30, and purgeExpiredPii() runs on boot. On
// 2026-07-14 a routine server restart — after a migration, on a dev box — silently
// and irreversibly deleted the raw uploaded rows of 47 real validation runs. Months
// of a colleague's work. No warning, no dry run, no confirmation, and no way back.
//
// Nobody had chosen a 30-day policy. They had simply not set a variable they did not
// know existed. That is the bug: an IRREVERSIBLE, DESTRUCTIVE sweep ran because of a
// DEFAULT.
//
// Two rules now, and this file exists to keep them:
//
//   1. Unset means OFF. The safe state is the default state. A destructive action
//      must be something a human asked for, not something they failed to prevent.
//   2. Even when switched on, it announces the body count and REFUSES the first time,
//      until a human has seen that number and said yes.
//
// The cost is that PII lives forever until someone turns retention on. That is a
// real cost, and it is the smaller one: unset retention is a liability you can fix
// any day; deleted merchant data is gone.
// ─────────────────────────────────────────────────────────────────────────────

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

async function loadRetention(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../src/services/retention.service');
}

describe('retention is off unless someone turns it on', () => {
  it('DEFAULTS TO OFF when RETENTION_DAYS is unset', async () => {
    const { RETENTION_DAYS } = await loadRetention({ RETENTION_DAYS: undefined });

    // The old default was 30. That number, unasked for, deleted 47 runs.
    expect(RETENTION_DAYS).toBe(0);
  });

  it('purges nothing when retention is off — without even reading the database', async () => {
    const { purgeExpiredPii } = await loadRetention({ RETENTION_DAYS: undefined });

    // No DB is configured in this unit test. If the purge tried to query one it
    // would throw; returning a clean summary proves it short-circuits before it can
    // touch anything at all.
    await expect(purgeExpiredPii()).resolves.toEqual({
      validationRuns: 0,
      productUploads: 0,
      skippedInFlight: 0,
    });
  });

  it('an explicit 0 also means off', async () => {
    const { RETENTION_DAYS } = await loadRetention({ RETENTION_DAYS: '0' });
    expect(RETENTION_DAYS).toBe(0);
  });

  it('takes the number when one is given on purpose', async () => {
    const { RETENTION_DAYS } = await loadRetention({ RETENTION_DAYS: '90' });
    expect(RETENTION_DAYS).toBe(90);
  });

  it('says how long data is kept, so the UI can explain a purged run', async () => {
    const { purgedMessage } = await loadRetention({ RETENTION_DAYS: '90' });
    expect(purgedMessage()).toContain('90 days');
  });
});
