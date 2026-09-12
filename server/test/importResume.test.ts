import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resume must never ask the shop anything, so any Shopify client it builds is a
// regression. The store lock needs a database; these are unit tests.
const shopifyClientCalls: (string | undefined)[] = [];
vi.mock('../src/services/shopifyClient', () => ({
  getShopifyClient: async (storeId?: string) => {
    shopifyClientCalls.push(storeId);
    throw new Error('resume must not consult the shop');
  },
}));
vi.mock('../src/services/storeLock.service', () => ({
  acquireStoreLock: async () => undefined,
}));

const { decideResume, resumeStore, STALE_CLAIM_MS, SUBMIT_OUTCOME_UNKNOWN } = await import(
  '../src/services/importResume.service'
);
import type { ResumableRow, ResumableStore } from '../src/services/importResume.service';
import { resetShopifyConfigCache } from '../src/config/shopify';

// ─────────────────────────────────────────────────────────────────────────────
// THE RESUME DECISION.
//
// A PENDING row means: the row is on disk, but we have no bulk-operation id for
// it. Shopify mints that id, so there is always a window where an op exists at
// Shopify and not in our database. What we CAN record before the side effect is
// intent — submitAttemptedAt, written just before bulkOperationRunMutation:
//
//   1. submitAttemptedAt NULL — provably never submitted. → RELAUNCH.
//   2. submitAttemptedAt set  — outcome unknown.          → FAIL, with a reason.
//
// Case 2 used to ADOPT the shop's newest bulk op if it postdated the row. From API
// 2026-01 an app runs up to FIVE bulk mutations per shop at once, and even before
// that any op created after the crash also postdated the row — so "newest" never
// meant "mine". Adopting a stranger's op misattributes every row; relaunching over
// an op that did land duplicates a merchant's import. The shop cannot tell us which
// op is ours, so the decision takes nothing from it.
// ─────────────────────────────────────────────────────────────────────────────

const ROW_CREATED = new Date('2026-07-14T12:00:00.000Z');
const ATTEMPTED = new Date('2026-07-14T12:00:02.000Z');

function row(overrides: Partial<ResumableRow> = {}): ResumableRow {
  return { id: 'run-1', storeId: 'ours-qa', createdAt: ROW_CREATED, submitAttemptedAt: null, ...overrides };
}

describe('decideResume', () => {
  it('relaunches a row that never attempted its submit', () => {
    expect(decideResume(row())).toEqual({ action: 'relaunch' });
  });

  // THE ONE THAT PREVENTS A DUPLICATE IMPORT. The op may have landed; nothing we
  // can ask Shopify will say whether it did.
  it('fails a row whose submit was attempted but never recorded an op id', () => {
    expect(decideResume(row({ submitAttemptedAt: ATTEMPTED }))).toEqual({
      action: 'fail',
      reason: SUBMIT_OUTCOME_UNKNOWN,
    });
  });

  it('tells the user what to check before re-running', () => {
    expect(SUBMIT_OUTCOME_UNKNOWN).toMatch(/may or may not have reached the store/);
    expect(SUBMIT_OUTCOME_UNKNOWN).toMatch(/QA cleanup/);
    expect(SUBMIT_OUTCOME_UNKNOWN).toMatch(/re-run/);
  });

  // An attempt a split-second after the row, or long after, is the same unknown.
  it('does not care how the attempt time relates to the row time', () => {
    for (const at of [ROW_CREATED, ATTEMPTED, new Date('2026-07-15T09:00:00.000Z')]) {
      expect(decideResume(row({ submitAttemptedAt: at })).action).toBe('fail');
    }
  });
});

describe('STALE_CLAIM_MS', () => {
  // A claim that is never reclaimable strands the row forever when the process
  // holding it is killed — trading a wrong answer for a permanent hang, which is
  // just a slower way of never telling the truth.
  it('is a finite, sane reclaim window', () => {
    expect(STALE_CLAIM_MS).toBeGreaterThan(60_000);
    expect(STALE_CLAIM_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

function fakeStore(rows: ResumableRow[]) {
  const calls = {
    claimed: [] as string[],
    relaunched: [] as string[],
    failed: [] as { id: string; error: string }[],
  };
  const store: ResumableStore = {
    label: 'test',
    findResumable: async () => rows,
    claim: async (id) => {
      calls.claimed.push(id);
      return true;
    },
    relaunch: async (id) => {
      calls.relaunched.push(id);
    },
    fail: async (id, error) => {
      calls.failed.push({ id, error });
    },
    lockOwner: (r) => ({
      ownerType: 'IMPORT_RUN',
      ownerId: r.id,
      operation: 'a customer import',
    }),
  };
  return { store, calls };
}

const OURS = 'ours-qa';
const THEIRS = 'theirs-qa';

beforeEach(() => {
  shopifyClientCalls.length = 0;
  process.env.SHOPIFY_TEST_STORES = JSON.stringify([
    { id: OURS, label: 'Ours', shop: 'ours-qa.myshopify.com', adminToken: 'shpat_ours' },
  ]);
  resetShopifyConfigCache();
});

afterEach(() => {
  delete process.env.SHOPIFY_TEST_STORES;
  resetShopifyConfigCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// CONCURRENT OPERATIONS ON ONE SHOP.
//
// Up to five bulk mutations per shop can be live at once, and more can land while
// we are down. None of that may leak into the decision: resume works from our own
// rows and never builds a Shopify client to look at the shop.
// ─────────────────────────────────────────────────────────────────────────────

describe('resumeStore — concurrent bulk operations on one shop', () => {
  it('never consults the shop, whatever it is running', async () => {
    const { store } = fakeStore([
      row({ id: 'never-attempted' }),
      row({ id: 'attempted', submitAttemptedAt: ATTEMPTED }),
    ]);

    await resumeStore(store);

    expect(shopifyClientCalls).toEqual([]);
  });

  // Two PENDING rows on the SAME store — e.g. a crash mid-fan-out after a batch
  // put two jobs on one shop. Under the old rule both could adopt the shop's newest
  // op, or the second could adopt the op the first one's relaunch had just created.
  it('resolves two PENDING rows on one store independently: one relaunch, one fail', async () => {
    const { store, calls } = fakeStore([
      row({ id: 'job-a' }),
      row({ id: 'job-b', submitAttemptedAt: ATTEMPTED }),
    ]);

    const summary = await resumeStore(store);

    expect(summary).toMatchObject({ relaunched: 1, failed: 1, skipped: 0 });
    expect(calls.relaunched).toEqual(['job-a']);
    expect(calls.failed.map((f) => f.id)).toEqual(['job-b']);
    expect(calls.failed[0].error).toContain(SUBMIT_OUTCOME_UNKNOWN);
  });

  it("a relaunch earlier in the pass cannot be picked up by a later row", async () => {
    // Order matters under any shop-lookup design: job-a's relaunch creates the
    // newest op on the shop just before job-b is examined. job-b must still fail.
    const { store, calls } = fakeStore([
      row({ id: 'job-a' }),
      row({ id: 'job-b', createdAt: new Date(ROW_CREATED.getTime() - 1), submitAttemptedAt: ROW_CREATED }),
    ]);

    await resumeStore(store);

    expect(calls.relaunched).toEqual(['job-a']);
    expect(calls.failed.map((f) => f.id)).toEqual(['job-b']);
  });

  it('relaunches every never-attempted row on a busy shop — none of them reached it', async () => {
    const { store, calls } = fakeStore(
      Array.from({ length: 5 }, (_, i) => row({ id: `job-${i}` })),
    );

    const summary = await resumeStore(store);

    expect(summary.relaunched).toBe(5);
    expect(calls.relaunched).toHaveLength(5);
    expect(calls.failed).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHOSE ROW IS THIS?
//
// Deployed one-instance-per-colleague against a SHARED database, every instance
// sees every PENDING row but holds tokens for only its own stores. An instance
// must leave another instance's rows completely alone.
//
// The danger is not that resume fails on a store it cannot reach — it is that it
// CLAIMS the row first. A claim followed by a failure marks a colleague's healthy,
// still-running import FAILED and tells them to re-run it, which duplicates the
// import. So the guard has to come before the claim, and that is exactly what these
// tests pin.
// ─────────────────────────────────────────────────────────────────────────────

describe('resumeStore — shared database, per-instance store tokens', () => {
  it('never claims a row whose store this instance has no token for', async () => {
    const { store, calls } = fakeStore([row({ storeId: THEIRS })]);

    const summary = await resumeStore(store);

    expect(calls.claimed).toEqual([]);
    expect(summary.skipped).toBe(1);
  });

  it("does not mark another instance's healthy run FAILED", async () => {
    const { store, calls } = fakeStore([row({ storeId: THEIRS, submitAttemptedAt: ATTEMPTED })]);

    await resumeStore(store);

    // The whole point: their import is still running at Shopify, driven by their
    // own instance. Failing it here would be a lie AND destroy their run.
    expect(calls.failed).toEqual([]);
  });

  it('does NOT skip when this instance has no usable store config', async () => {
    // An empty or unparseable store list makes resolveStoreId return null for
    // EVERY store alike, so an unguarded ownership check would match every row
    // and resume would silently do nothing — a misconfiguration turned into a
    // no-op, which is precisely what this service exists to prevent. With
    // nothing to judge ownership against, rows must fall through to the normal
    // path and fail loudly instead.
    process.env.SHOPIFY_TEST_STORES = '[]';
    resetShopifyConfigCache();

    const { store, calls } = fakeStore([row({ storeId: THEIRS })]);

    const summary = await resumeStore(store);

    expect(summary.skipped).toBe(0);
    expect(calls.claimed).toEqual(['run-1']);
  });

  it('skips every foreign row without touching any of them', async () => {
    const { store, calls } = fakeStore([
      row({ id: 'run-1', storeId: THEIRS }),
      row({ id: 'run-2', storeId: 'third-qa' }),
    ]);

    const summary = await resumeStore(store);

    expect(summary.skipped).toBe(2);
    expect(summary.failed).toBe(0);
    expect(calls.claimed).toEqual([]);
    expect(calls.failed).toEqual([]);
  });
});
