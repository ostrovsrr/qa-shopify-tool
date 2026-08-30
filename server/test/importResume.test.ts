import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decideResume,
  resumeStore,
  STALE_CLAIM_MS,
} from '../src/services/importResume.service';
import type { ResumableRow, ResumableStore } from '../src/services/importResume.service';
import { resetShopifyConfigCache } from '../src/config/shopify';
import type { CurrentBulkOperation } from '../src/services/shopifyBulk';

// ─────────────────────────────────────────────────────────────────────────────
// THE RESUME DECISION.
//
// A PENDING row means: the row is on disk, but we have no bulk-operation id for
// it. The process died somewhere between writing the row and recording the id.
// Exactly one of two things is true, and telling them apart is the entire job:
//
//   1. We DID submit an op and died before saving its id. Shopify allows one bulk
//      mutation per shop, so that op is the shop's CURRENT one and it was created
//      AFTER our row. → ADOPT. Re-submitting would bounce off the per-shop limit,
//      or — if the first op had already finished — DUPLICATE a merchant's import.
//
//   2. We died BEFORE submitting. Nothing on the shop postdates our row.
//      → RELAUNCH. Provably safe: no records exist for this row.
//
// Get this backwards and you either duplicate an entire import into a store, or
// silently drop one and report success. Hence the exhaustive table below.
// ─────────────────────────────────────────────────────────────────────────────

const ROW_CREATED = new Date('2026-07-14T12:00:00.000Z');

function op(overrides: Partial<CurrentBulkOperation> = {}): CurrentBulkOperation {
  return {
    id: 'gid://shopify/BulkOperation/1',
    status: 'RUNNING',
    errorCode: null,
    objectCount: '10',
    url: null,
    partialDataUrl: null,
    createdAt: '2026-07-14T12:00:05.000Z', // 5s AFTER the row → ours
    ...overrides,
  };
}

describe('decideResume', () => {
  it('relaunches when the shop has never run a bulk operation', () => {
    expect(decideResume(ROW_CREATED, null)).toEqual({ action: 'relaunch' });
  });

  it('adopts an operation created after the row (we submitted it, then died)', () => {
    expect(decideResume(ROW_CREATED, op())).toEqual({
      action: 'adopt',
      bulkOperationId: 'gid://shopify/BulkOperation/1',
      opStatus: 'RUNNING',
    });
  });

  // THE ONE THAT PREVENTS A DUPLICATE IMPORT. The op finished during our downtime.
  // It is still ours, and its records are already in the store. Adopting recovers
  // the results; relaunching would import every record a second time.
  it('adopts an operation that ALREADY COMPLETED after the row was written', () => {
    const decision = decideResume(
      ROW_CREATED,
      op({ status: 'COMPLETED', url: 'https://results/1' }),
    );
    expect(decision).toMatchObject({ action: 'adopt', opStatus: 'COMPLETED' });
  });

  it('adopts a FAILED operation too — it is still ours, and the reconcile must see it', () => {
    expect(decideResume(ROW_CREATED, op({ status: 'FAILED' }))).toMatchObject({
      action: 'adopt',
      opStatus: 'FAILED',
    });
  });

  // THE ONE THAT PREVENTS A SILENTLY DROPPED IMPORT. The shop's current op predates
  // our row, so it belongs to some earlier run. Ours was never submitted.
  it('relaunches when the shop op predates the row (it belongs to an earlier run)', () => {
    const decision = decideResume(
      ROW_CREATED,
      op({ createdAt: '2026-07-14T11:59:59.000Z' }), // 1s BEFORE the row
    );
    expect(decision).toEqual({ action: 'relaunch' });
  });

  it('does NOT adopt a long-finished op from a previous import', () => {
    const decision = decideResume(
      ROW_CREATED,
      op({ status: 'COMPLETED', createdAt: '2026-07-01T09:00:00.000Z' }),
    );
    expect(decision).toEqual({ action: 'relaunch' });
  });

  // The boundary. Same millisecond → adopt. A false ADOPT merely re-reads an op we
  // own; a false RELAUNCH duplicates real records in a real store. So the tie goes
  // to adopt, deliberately.
  it('adopts on an exact timestamp tie (the safe side of the boundary)', () => {
    const decision = decideResume(ROW_CREATED, op({ createdAt: ROW_CREATED.toISOString() }));
    expect(decision).toMatchObject({ action: 'adopt' });
  });

  it('relaunches one millisecond before the tie', () => {
    const justBefore = new Date(ROW_CREATED.getTime() - 1).toISOString();
    expect(decideResume(ROW_CREATED, op({ createdAt: justBefore }))).toEqual({
      action: 'relaunch',
    });
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
// import or bounces off the per-shop limit. So the guard has to come before the
// claim, and that is exactly what these tests pin.
// ─────────────────────────────────────────────────────────────────────────────

describe('resumeStore — shared database, per-instance store tokens', () => {
  const OURS = 'ours-qa';
  const THEIRS = 'theirs-qa';

  function fakeStore(rows: ResumableRow[]) {
    const calls = { claimed: [] as string[], failed: [] as string[] };
    const store: ResumableStore = {
      label: 'test',
      findResumable: async () => rows,
      claim: async (id) => {
        calls.claimed.push(id);
        return true;
      },
      adopt: async () => undefined,
      relaunch: async () => undefined,
      fail: async (id) => {
        calls.failed.push(id);
      },
      lockOwner: (row) => ({
        ownerType: 'IMPORT_RUN',
        ownerId: row.id,
        operation: 'a customer import',
      }),
    };
    return { store, calls };
  }

  beforeEach(() => {
    process.env.SHOPIFY_TEST_STORES = JSON.stringify([
      { id: OURS, label: 'Ours', shop: 'ours-qa.myshopify.com', adminToken: 'shpat_ours' },
    ]);
    resetShopifyConfigCache();
  });

  afterEach(() => {
    delete process.env.SHOPIFY_TEST_STORES;
    resetShopifyConfigCache();
  });

  it('never claims a row whose store this instance has no token for', async () => {
    const { store, calls } = fakeStore([
      { id: 'run-1', storeId: THEIRS, createdAt: ROW_CREATED },
    ]);

    const summary = await resumeStore(store);

    expect(calls.claimed).toEqual([]);
    expect(summary.skipped).toBe(1);
  });

  it("does not mark another instance's healthy run FAILED", async () => {
    const { store, calls } = fakeStore([
      { id: 'run-1', storeId: THEIRS, createdAt: ROW_CREATED },
    ]);

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

    const { store, calls } = fakeStore([
      { id: 'run-1', storeId: THEIRS, createdAt: ROW_CREATED },
    ]);

    const summary = await resumeStore(store);

    expect(summary.skipped).toBe(0);
    expect(calls.claimed).toEqual(['run-1']);
  });

  it('skips every foreign row without touching any of them', async () => {
    const { store, calls } = fakeStore([
      { id: 'run-1', storeId: THEIRS, createdAt: ROW_CREATED },
      { id: 'run-2', storeId: 'third-qa', createdAt: ROW_CREATED },
    ]);

    const summary = await resumeStore(store);

    expect(summary.skipped).toBe(2);
    expect(summary.failed).toBe(0);
    expect(calls.claimed).toEqual([]);
    expect(calls.failed).toEqual([]);
  });
});
