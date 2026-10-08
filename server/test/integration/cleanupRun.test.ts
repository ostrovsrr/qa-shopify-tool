import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// ASYNC CLEANUP.
//
// Cleanup used to poll Shopify inside the HTTP request for up to 300 SECONDS
// (150 attempts x 2s, deliberately). A hosting proxy gives up around 100s, so the
// request would die while the delete was still running and the user would be told
// nothing — on the highest-blast-radius routes in the app, the ones that delete by
// tag across an entire store.
//
// It is now a persisted run advanced one step per poll, like an import. These tests
// pin: the submit does not block, the row lands BEFORE the delete is submitted, the
// poll finishes it, and small teardowns still run inline.
// ─────────────────────────────────────────────────────────────────────────────

let taggedIds: string[] = [];
let opStatus = 'RUNNING';
let opUrl: string | null = null;
const submittedOps: string[] = [];
let serialDeletes = 0;

const fakeClient = {
  shop: 'fake.myshopify.com',
  verifyConnection: async () => ({ ok: true, shop: 'fake.myshopify.com' }),
  query: async (q: string) => {
    // Tag lookup (the `products`/`customers` connection).
    if (q.includes('pageInfo')) {
      const key = q.includes('products') ? 'products' : 'customers';
      return {
        [key]: {
          nodes: taggedIds.map((id) => ({ id })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    // Serial per-id delete.
    if (q.includes('productDelete') || q.includes('deleteCustomer')) {
      serialDeletes++;
      const key = q.includes('productDelete') ? 'productDelete' : 'customerDelete';
      const idKey = key === 'productDelete' ? 'deletedProductId' : 'deletedCustomerId';
      return { [key]: { [idKey]: 'gid://deleted', userErrors: [] } };
    }
    return {};
  },
};

/** When set, getShopifyClient throws it — an instance with no token for the store. */
let clientError: Error | null = null;
/** How the bulk-delete submit fails, if it does: before the mutation call (nothing
 *  reached Shopify), after markSubmitAttempt (outcome unknown), or Shopify's
 *  definite refusal at the per-shop concurrent limit. */
type SubmitFailure = 'before-mutation' | 'during-mutation' | 'concurrency' | null;
let submitFailure: SubmitFailure = null;
/** Per-submit failure by call order (op i is submitted i-th); overrides submitFailure. */
let submitFailures: SubmitFailure[] = [];
let submitCalls = 0;
/** The ids each submit was given, by call order. */
const submittedSlices: string[][] = [];
/** The ids each result-file parse was given. */
const parsedSlices: string[][] = [];
/** Per-op Shopify state by bulk op id; an op not listed reads opStatus / opUrl. */
const opState = new Map<string, { status?: string; error?: Error }>();
/** When set, fetchBulkOperationState throws it. */
let fetchError: Error | null = null;
/** Runs inside fetchBulkOperationState — lets a test stage a concurrent poll. */
let onFetch: (() => Promise<void>) | null = null;

vi.mock('../../src/services/shopifyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyClient')>();
  return {
    ...actual,
    getShopifyClient: async () => {
      if (clientError) throw clientError;
      return fakeClient;
    },
  };
});

vi.mock('../../src/services/shopifyBulk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyBulk')>();
  return {
    ...actual,
    submitBulkDelete: async (
      _client: unknown,
      ids: string[],
      _spec: unknown,
      beforeRun?: () => Promise<void>,
    ) => {
      // Taken before any await, so the n-th call is the n-th op launched.
      const n = submitCalls++;
      submittedSlices[n] = ids;
      const failure = submitFailures[n] ?? submitFailure;
      if (failure === 'before-mutation') throw new Error('staged upload failed');
      if (beforeRun) await beforeRun();
      if (failure === 'during-mutation') throw new Error('socket hang up');
      if (failure === 'concurrency') throw new actual.BulkConcurrencyLimitError();
      const id = `gid://shopify/BulkOperation/del-${n + 1}`;
      submittedOps.push(id);
      return id;
    },
    fetchBulkOperationState: async (_c: unknown, id: string) => {
      if (onFetch) await onFetch();
      if (fetchError) throw fetchError;
      const own = opState.get(id);
      if (own?.error) throw own.error;
      return {
        id,
        status: own?.status ?? opStatus,
        errorCode: null,
        objectCount: String(taggedIds.length),
        url: opUrl,
        partialDataUrl: null,
      };
    },
    // One refused id per op — the last of the slice it was given — so the totals
    // and errors show exactly which slice each op's result was mapped back to.
    parseBulkDeleteResults: async (_url: string, ids: string[]) => {
      parsedSlices.push(ids);
      return {
        deleted: ids.length - 1,
        errors: [{ id: ids[ids.length - 1], message: 'Product is referenced by an order' }],
      };
    },
  };
});

const prisma = (await import('../../src/db/prisma')).default;
const { resetDb } = await import('./resetDb');
const { startCleanupRun, reconcileCleanupRun, sweepRunningCleanups } = await import(
  '../../src/services/cleanupRun.service'
);
const { MAX_JOB_POLL_ATTEMPTS, splitIntoBatches } = await import('../../src/services/shopifyBulk');
const app = (await import('../../src/index')).default;
const request = (await import('supertest')).default;
const { resetShopifyConfigCache } = await import('../../src/config/shopify');
const { busyStores } = await import('../../src/services/storeLock.service');

const lockOn = (storeId: string) => prisma.storeLock.findUnique({ where: { storeId } });

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const manyIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `gid://shopify/Product/${i + 1}`);

runIf('async cleanup', () => {
  beforeEach(async () => {
    taggedIds = [];
    opStatus = 'RUNNING';
    opUrl = null;
    submittedOps.length = 0;
    serialDeletes = 0;
    clientError = null;
    submitFailure = null;
    submitFailures = [];
    submitCalls = 0;
    submittedSlices.length = 0;
    parsedSlices.length = 0;
    opState.clear();
    fetchError = null;
    onFetch = null;
    // Pinned, not left to the default: the op counts below depend on it.
    vi.stubEnv('BULK_OPS_PER_STORE', '5');
    await resetDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    process.env.SHOPIFY_TEST_STORES = '[]';
    resetShopifyConfigCache();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── THE POINT OF THE WHOLE CHANGE ─────────────────────────────────────────
  // A big teardown returns immediately with a RUNNING run. It does NOT sit in the
  // request waiting for Shopify.
  it('returns a RUNNING run immediately for a large teardown, without blocking', async () => {
    taggedIds = manyIds(200); // well over the 50-id inline threshold

    const started = Date.now();
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');
    const elapsed = Date.now() - started;

    expect(run.status).toBe('RUNNING');
    // The deletes live on the run's ops now, not on the run.
    expect(run.bulkOperationId).toBeNull();
    expect(submittedOps).toHaveLength(5);
    expect(run.found).toBe(200);
    // The old code would have polled here for up to 300 seconds.
    expect(elapsed).toBeLessThan(2_000);
  });

  // The ids are needed by the RECONCILE, which happens in a different request than
  // the submit. If they were not persisted, the result file could not be mapped back
  // to them and every delete would be reported against the wrong record.
  it('persists the submitted ids so a later poll can map the results back', async () => {
    taggedIds = manyIds(60);
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');
    expect(run.submittedIds).toHaveLength(60);
  });

  it('advances on poll and finalizes with real deleted/failed counts', async () => {
    taggedIds = manyIds(100);
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');

    // Still deleting.
    opStatus = 'RUNNING';
    const midway = await reconcileCleanupRun(run.id);
    expect(midway?.status).toBe('RUNNING');

    // Shopify finished.
    opStatus = 'COMPLETED';
    opUrl = 'https://results/cleanup';
    const done = await reconcileCleanupRun(run.id);

    // Five ops of 20, each refusing the last id of its own slice.
    expect(done?.status).toBe('COMPLETED');
    expect(done?.deleted).toBe(95);
    expect(done?.failedCount).toBe(5);
    expect(done?.errors).toEqual(
      [20, 40, 60, 80, 100].map((n) => ({
        id: `gid://shopify/Product/${n}`,
        message: 'Product is referenced by an order',
      })),
    );
    expect(await lockOn('store1')).toBeNull();
  });

  // ── THE STORE MUST NOT STAY "BUSY" AFTER THE DELETE FINISHES ───────────────
  // A bulk cleanup holds its store lock until reconcile brings it terminal, and
  // reconcile only ran when a browser polled GET /api/cleanup/:id. A watcher that
  // walked away — closed tab, or a delete that outran the client's ~5-min poll cap
  // — left the run RUNNING with Shopify already done, so the store read "busy" until
  // the 30-min lock TTL. The server-side sweep is the backstop: it advances the
  // orphan itself and hands the store back, with no client in the loop.
  it('sweepRunningCleanups frees a store whose cleanup finished but nobody polled', async () => {
    taggedIds = manyIds(100);
    const run = await startCleanupRun('CUSTOMER', 'store1', 'qa-import');

    // Precondition: the bulk path holds the store lock while RUNNING.
    expect(run.status).toBe('RUNNING');
    expect(
      await prisma.storeLock.findUnique({ where: { storeId: 'store1' } }),
    ).not.toBeNull();

    // Shopify finished the delete, but no browser is polling this run.
    opStatus = 'COMPLETED';
    opUrl = 'https://results/cleanup';

    await sweepRunningCleanups();

    const done = await prisma.cleanupRun.findUnique({ where: { id: run.id } });
    expect(done?.status).toBe('COMPLETED');
    expect(done?.deleted).toBe(95);
    // The store is free again — no lingering lock, no false "busy".
    expect(await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })).toBeNull();
  });

  // Every instance shares one database but holds only its own SE's stores. The
  // sweep used to reconcile EVERY running cleanup, so a colleague's cleanup made
  // each other instance log "store is not configured" once a minute — which is
  // what the fleet status page then showed as every instance's last error.
  it("sweepRunningCleanups leaves a colleague's cleanup alone, and still sweeps its own", async () => {
    const { resetShopifyConfigCache } = await import('../../src/config/shopify');
    process.env.SHOPIFY_TEST_STORES = JSON.stringify([
      { id: 'store1', shop: 'store1.myshopify.com', adminToken: 'shpat_x', apiVersion: '2026-01' },
    ]);
    resetShopifyConfigCache();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const theirs = await prisma.cleanupRun.create({
        data: {
          entity: 'PRODUCT',
          storeId: 'someone-elses-store',
          shopDomain: 'someone-elses-store.myshopify.com',
          tag: 'qa-import',
          status: 'RUNNING',
          bulkOperationId: 'gid://shopify/BulkOperation/theirs',
          submittedIds: manyIds(100),
        },
      });
      taggedIds = manyIds(100);
      const mine = await startCleanupRun('CUSTOMER', 'store1', 'qa-import');
      opStatus = 'COMPLETED';
      opUrl = 'https://results/cleanup';

      await sweepRunningCleanups();

      expect((await prisma.cleanupRun.findUnique({ where: { id: mine.id } }))?.status).toBe('COMPLETED');
      expect((await prisma.cleanupRun.findUnique({ where: { id: theirs.id } }))?.status).toBe('RUNNING');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      process.env.SHOPIFY_TEST_STORES = '[]';
      resetShopifyConfigCache();
    }
  });

  it('marks the run FAILED when Shopify ends the operation non-COMPLETED', async () => {
    taggedIds = manyIds(100);
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');

    opStatus = 'FAILED';
    const done = await reconcileCleanupRun(run.id);

    expect(done?.status).toBe('FAILED');
    expect(done?.error).toContain('Bulk delete FAILED');
  });

  // ── SMALL TEARDOWNS STILL RUN INLINE ──────────────────────────────────────
  // ~50 sequential deletes take a couple of seconds — well inside any proxy — and
  // paying the staged-upload + poll cost for them would be slower, not faster.
  it('deletes a small teardown inline and returns COMPLETED, with no bulk op', async () => {
    taggedIds = manyIds(3);

    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');

    expect(run.status).toBe('COMPLETED');
    expect(run.deleted).toBe(3);
    expect(run.bulkOperationId).toBeNull();
    expect(submittedOps).toEqual([]);
    expect(serialDeletes).toBe(3);
  });

  it('completes immediately when nothing is tagged', async () => {
    taggedIds = [];
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');
    expect(run.status).toBe('COMPLETED');
    expect(run.found).toBe(0);
    expect(run.deleted).toBe(0);
  });

  // ── THE TWINS ─────────────────────────────────────────────────────────────
  it('runs the same engine for customers', async () => {
    taggedIds = manyIds(80);
    const run = await startCleanupRun('CUSTOMER', 'store1', 'qa-import');
    expect(run.entity).toBe('CUSTOMER');
    expect(run.status).toBe('RUNNING');
    expect(run.found).toBe(80);
  });

  // ── NEVER TAKE A SIDE EFFECT YOU HAVE NOT RECORDED ────────────────────────
  it('links the cleanup to the import it is reversing', async () => {
    taggedIds = manyIds(60);
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import-abc', 'abc');
    expect(run.importRunId).toBe('abc');
    expect(run.tag).toBe('qa-import-abc');
  });

  // ── SHARED DATABASE: ONLY THE OWNING INSTANCE ADVANCES A CLEANUP ──────────
  // Eleven instances share one database, each with tokens for its own stores. A
  // non-owner's reconcile used to bump pollAttempts BEFORE discovering it could not
  // build a client, so ten instances' sweeps burned the cap and the run was failed
  // — store released — while Shopify was still deleting.
  //
  // These seed a run the way it was written BEFORE the split into cleanup_ops (one
  // op, its id on the run itself), so they also pin that such a row, RUNNING across
  // the deploy, still reconciles to the end.
  async function runningCleanup(storeId: string, pollAttempts = 0) {
    const run = await prisma.cleanupRun.create({
      data: {
        entity: 'CUSTOMER',
        storeId,
        shopDomain: `${storeId}.myshopify.com`,
        tag: 'qa-import',
        status: 'RUNNING',
        bulkOperationId: `gid://shopify/BulkOperation/${storeId}`,
        submittedIds: ['gid://shopify/Customer/1'],
        pollAttempts,
      },
    });
    await prisma.storeLock.create({
      data: {
        storeId,
        ownerType: 'CLEANUP_RUN',
        ownerId: run.id,
        operation: 'a customer cleanup',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    return run;
  }

  it("the sweep leaves another instance's cleanups alone", async () => {
    process.env.SHOPIFY_TEST_STORES = JSON.stringify([
      // apiVersion explicitly: setEnv blanks SHOPIFY_API_VERSION, which would fail it.
      { id: 'mine', shop: 'mine.myshopify.com', adminToken: 'shpat_test', apiVersion: '2026-01' },
    ]);
    resetShopifyConfigCache();
    const mine = await runningCleanup('mine');
    const theirs = await runningCleanup('theirs');
    opStatus = 'COMPLETED';

    await sweepRunningCleanups();

    expect((await prisma.cleanupRun.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe(
      'COMPLETED',
    );
    const untouched = await prisma.cleanupRun.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(untouched).toMatchObject({ status: 'RUNNING', pollAttempts: 0 });
    expect(await lockOn('theirs')).not.toBeNull();
  });

  it('a reconcile that cannot build a client does not spend the poll budget', async () => {
    const run = await runningCleanup('store1', MAX_JOB_POLL_ATTEMPTS);
    clientError = new Error('Store "store1" is not configured.');

    await expect(reconcileCleanupRun(run.id)).rejects.toThrow('not configured');

    const after = await prisma.cleanupRun.findUniqueOrThrow({ where: { id: run.id } });
    // Not failed, not counted, store still held.
    expect(after).toMatchObject({ status: 'RUNNING', pollAttempts: MAX_JOB_POLL_ATTEMPTS });
    expect(await lockOn('store1')).not.toBeNull();
  });

  it('counts concurrent polls atomically', async () => {
    const run = await runningCleanup('store1');

    await Promise.all([reconcileCleanupRun(run.id), reconcileCleanupRun(run.id)]);

    expect((await prisma.cleanupRun.findUniqueOrThrow({ where: { id: run.id } })).pollAttempts).toBe(2);
  });

  // ── THE CAP MUST NOT FREE A STORE UNDER A LIVE DELETE ─────────────────────
  it('past the poll cap, a delete Shopify still reports RUNNING stays RUNNING and locked', async () => {
    const run = await runningCleanup('store1', MAX_JOB_POLL_ATTEMPTS);
    opStatus = 'RUNNING';

    const after = await reconcileCleanupRun(run.id);

    expect(after?.status).toBe('RUNNING');
    expect(await lockOn('store1')).not.toBeNull();

    // And once Shopify finishes, it finalizes normally.
    opStatus = 'COMPLETED';
    expect((await reconcileCleanupRun(run.id))?.status).toBe('COMPLETED');
    expect(await lockOn('store1')).toBeNull();
  });

  it('past the poll cap, a delete whose status cannot be read is failed and the store freed', async () => {
    const run = await runningCleanup('store1', MAX_JOB_POLL_ATTEMPTS);
    fetchError = new Error('Bulk operation not found while polling.');

    const after = await reconcileCleanupRun(run.id);

    expect(after?.status).toBe('FAILED');
    expect(after?.error).toContain('Could not read');
    expect(await lockOn('store1')).toBeNull();
  });

  it('under the cap, an unreadable status is just a bad poll', async () => {
    const run = await runningCleanup('store1');
    fetchError = new Error('network down');

    await expect(reconcileCleanupRun(run.id)).rejects.toThrow('network down');
    expect((await prisma.cleanupRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      'RUNNING',
    );
  });

  // ── A SLOWER POLL MUST NOT OVERWRITE A TERMINAL RESULT ────────────────────
  it('does not overwrite a result another poll already finalized', async () => {
    const run = await runningCleanup('store1');
    // While this poll is waiting on Shopify, a faster one finalizes the run.
    onFetch = async () => {
      await prisma.cleanupRun.update({
        where: { id: run.id },
        data: { status: 'COMPLETED', deleted: 1 },
      });
    };
    opStatus = 'FAILED';

    const after = await reconcileCleanupRun(run.id);

    expect(after).toMatchObject({ status: 'COMPLETED', deleted: 1, error: null });
  });

  // ── AN AMBIGUOUS SUBMIT DOES NOT HAND THE STORE BACK ──────────────────────
  it('keeps the store locked when the bulk delete may have reached Shopify', async () => {
    taggedIds = manyIds(100);
    submitFailure = 'during-mutation';

    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');

    expect(run.status).toBe('FAILED');
    expect(run.error).toContain('may or may not have reached Shopify');
    expect((await lockOn('store1'))?.ownerId).toBe(run.id);
    // And the store reads busy, not free: a FAILED-mid-submit holder is honoured.
    expect((await busyStores()).map((b) => b.storeId)).toEqual(['store1']);
  });

  it('frees the store when the submit provably never reached Shopify', async () => {
    taggedIds = manyIds(100);
    submitFailure = 'before-mutation';

    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');

    expect(run.status).toBe('FAILED');
    expect(run.error).toContain('staged upload failed');
    expect(await lockOn('store1')).toBeNull();
  });

  // ── K DELETES PER STORE ───────────────────────────────────────────────────
  const opsOf = (runId: string) =>
    prisma.cleanupOp.findMany({ where: { cleanupRunId: runId }, orderBy: { opIndex: 'asc' } });

  it('splits a big teardown into k ops, each given its own slice, and sums them', async () => {
    taggedIds = manyIds(103);
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');

    const ops = await opsOf(run.id);
    expect(ops.map((o) => [o.opIndex, o.opCount, o.status])).toEqual(
      [0, 1, 2, 3, 4].map((i) => [i, 5, 'RUNNING']),
    );
    expect(ops.every((o) => o.bulkOperationId)).toBe(true);
    // Contiguous and complete: every id deleted exactly once.
    expect(submittedSlices).toEqual(splitIntoBatches(taggedIds, 5));

    opStatus = 'COMPLETED';
    opUrl = 'https://results/cleanup';
    const done = await reconcileCleanupRun(run.id);

    // Each result file was mapped back to the slice of the op it belongs to.
    expect([...parsedSlices].sort((a, b) => a.length - b.length || a[0].localeCompare(b[0]))).toEqual(
      [...splitIntoBatches(taggedIds, 5)].sort((a, b) => a.length - b.length || a[0].localeCompare(b[0])),
    );
    expect(done).toMatchObject({ status: 'COMPLETED', deleted: 98, failedCount: 5, error: null });
    expect(await lockOn('store1')).toBeNull();
  });

  it('BULK_OPS_PER_STORE=1 runs one op over every id', async () => {
    vi.stubEnv('BULK_OPS_PER_STORE', '1');
    taggedIds = manyIds(100);
    const run = await startCleanupRun('CUSTOMER', 'store1', 'qa-import');

    expect(await opsOf(run.id)).toHaveLength(1);
    expect(submittedSlices).toEqual([taggedIds]);

    opStatus = 'COMPLETED';
    opUrl = 'https://results/cleanup';
    expect(await reconcileCleanupRun(run.id)).toMatchObject({ status: 'COMPLETED', deleted: 99 });
  });

  it('keeps the store held while any op is still deleting', async () => {
    taggedIds = manyIds(100);
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');
    opUrl = 'https://results/cleanup';
    opStatus = 'COMPLETED';
    opState.set('gid://shopify/BulkOperation/del-3', { status: 'RUNNING' });

    const midway = await reconcileCleanupRun(run.id);

    expect(midway?.status).toBe('RUNNING');
    expect((await opsOf(run.id)).map((o) => o.status)).toEqual([
      'COMPLETED', 'COMPLETED', 'RUNNING', 'COMPLETED', 'COMPLETED',
    ]);
    expect((await lockOn('store1'))?.ownerId).toBe(run.id);

    opState.clear();
    expect(await reconcileCleanupRun(run.id)).toMatchObject({ status: 'COMPLETED', deleted: 95 });
    expect(await lockOn('store1')).toBeNull();
  });

  it('a partial failure ends FAILED, keeps what was deleted, and names the op', async () => {
    taggedIds = manyIds(100);
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');
    opStatus = 'COMPLETED';
    opUrl = 'https://results/cleanup';
    opState.set('gid://shopify/BulkOperation/del-2', { status: 'CANCELED' });

    const done = await reconcileCleanupRun(run.id);

    expect(done).toMatchObject({ status: 'FAILED', deleted: 76, failedCount: 4 });
    expect(done?.error).toContain('1 of 5 deletes did not complete');
    expect(done?.error).toContain('Delete 2: Bulk delete CANCELED');
    // Nothing is running any more, so the store is handed back.
    expect(await lockOn('store1')).toBeNull();
  });

  it('two concurrent polls finish each op once, and the run once', async () => {
    taggedIds = manyIds(100);
    const run = await startCleanupRun('CUSTOMER', 'store1', 'qa-import');
    opStatus = 'COMPLETED';
    opUrl = 'https://results/cleanup';

    await Promise.all([reconcileCleanupRun(run.id), reconcileCleanupRun(run.id)]);

    const done = await prisma.cleanupRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'COMPLETED', deleted: 95, failedCount: 5 });
  });

  // ── AN AMBIGUOUS OP KEEPS THE STORE AFTER THE ROLL-UP ─────────────────────
  it('an op whose submit outcome is unknown keeps the store busy after the others finish', async () => {
    taggedIds = manyIds(100);
    submitFailures = [null, 'during-mutation', null, null, null];
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');

    expect(run.status).toBe('RUNNING');
    const ops = await opsOf(run.id);
    expect(ops[1]).toMatchObject({ status: 'FAILED', bulkOperationId: null });
    expect(ops[1].submitAttemptedAt).not.toBeNull();
    expect(ops[1].error).toContain('may or may not have reached Shopify');

    opStatus = 'COMPLETED';
    opUrl = 'https://results/cleanup';
    const done = await reconcileCleanupRun(run.id);

    expect(done).toMatchObject({ status: 'FAILED', deleted: 76, failedCount: 4, bulkOperationId: null });
    expect(done?.error).toContain('may or may not have reached Shopify');
    // The run is now the "FAILED while submitting" holder storeLock honours to the TTL.
    expect(done?.submitAttemptedAt).not.toBeNull();
    expect((await lockOn('store1'))?.ownerId).toBe(run.id);
    expect((await busyStores()).map((b) => b.storeId)).toEqual(['store1']);
  });

  it("Shopify's concurrent-limit refusal is definite: the op is not outcome-unknown", async () => {
    taggedIds = manyIds(100);
    submitFailure = 'concurrency';

    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');

    expect(run.status).toBe('FAILED');
    expect(run.error).toContain('Too many bulk operations');
    expect(run.submitAttemptedAt).toBeNull();
    expect((await opsOf(run.id)).every((o) => o.submitAttemptedAt === null)).toBe(true);
    expect(await lockOn('store1')).toBeNull();
  });

  // ── PER-OP POLL RULES ─────────────────────────────────────────────────────
  it('past the cap, an op whose status cannot be read is failed; the others still finish', async () => {
    taggedIds = manyIds(100);
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');
    const ops = await opsOf(run.id);
    await prisma.cleanupOp.update({
      where: { id: ops[0].id },
      data: { pollAttempts: MAX_JOB_POLL_ATTEMPTS },
    });
    opStatus = 'COMPLETED';
    opUrl = 'https://results/cleanup';
    opState.set(ops[0].bulkOperationId!, { error: new Error('Bulk operation not found while polling.') });

    const done = await reconcileCleanupRun(run.id);

    expect(done).toMatchObject({ status: 'FAILED', deleted: 76, failedCount: 4 });
    expect(done?.error).toContain('Delete 1: Could not read');
    // The unreadable op had an op id: not a submit-time ambiguity, so the store is freed.
    expect(await lockOn('store1')).toBeNull();
  });

  it('under the cap, one op\'s bad poll is reported but the others still advance', async () => {
    taggedIds = manyIds(100);
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');
    opStatus = 'COMPLETED';
    opUrl = 'https://results/cleanup';
    opState.set('gid://shopify/BulkOperation/del-4', { error: new Error('network down') });

    await expect(reconcileCleanupRun(run.id)).rejects.toThrow('network down');

    expect((await opsOf(run.id)).map((o) => o.status)).toEqual([
      'COMPLETED', 'COMPLETED', 'COMPLETED', 'RUNNING', 'COMPLETED',
    ]);
    expect((await prisma.cleanupRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('RUNNING');
  });

  it('a non-owner instance does not spend any op\'s poll budget', async () => {
    taggedIds = manyIds(100);
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');
    clientError = new Error('Store "store1" is not configured.');

    await expect(reconcileCleanupRun(run.id)).rejects.toThrow('not configured');

    expect((await opsOf(run.id)).every((o) => o.pollAttempts === 0)).toBe(true);
  });

  // ── THE RESPONSE ──────────────────────────────────────────────────────────
  it('GET /api/cleanup/:id does not send the id list or op internals', async () => {
    taggedIds = manyIds(100);
    const run = await startCleanupRun('PRODUCT', 'store1', 'qa-import');

    const res = await request(app).get(`/api/cleanup/${run.id}`);

    expect(res.status).toBe(200);
    // Everything client/src/api/cleanupPoller.ts reads...
    for (const key of [
      'id', 'entity', 'storeId', 'shopDomain', 'tag', 'status',
      'found', 'deleted', 'failedCount', 'error', 'errors',
    ]) {
      expect(res.body).toHaveProperty(key);
    }
    expect(res.body).toMatchObject({ id: run.id, status: 'RUNNING', found: 100 });
    // ...and none of what can be 80k ids long or is the server's business.
    for (const key of ['submittedIds', 'ops', 'bulkOperationId', 'pollAttempts', 'claimedAt', 'submitAttemptedAt']) {
      expect(res.body).not.toHaveProperty(key);
    }
  });
});
