import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../src/services/shopifyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyClient')>();
  return { ...actual, getShopifyClient: async () => fakeClient };
});

vi.mock('../../src/services/shopifyBulk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyBulk')>();
  return {
    ...actual,
    submitBulkDelete: async () => {
      const id = `gid://shopify/BulkOperation/del-${submittedOps.length + 1}`;
      submittedOps.push(id);
      return id;
    },
    fetchBulkOperationState: async (_c: unknown, id: string) => ({
      id,
      status: opStatus,
      errorCode: null,
      objectCount: String(taggedIds.length),
      url: opUrl,
      partialDataUrl: null,
    }),
    parseBulkDeleteResults: async (_url: string, ids: string[]) => ({
      deleted: ids.length - 1,
      errors: [{ id: ids[ids.length - 1], message: 'Product is referenced by an order' }],
    }),
  };
});

const prisma = (await import('../../src/db/prisma')).default;
const { resetDb } = await import('./resetDb');
const { startCleanupRun, reconcileCleanupRun } = await import(
  '../../src/services/cleanupRun.service'
);

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
    await resetDb();
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
    expect(run.bulkOperationId).toBe('gid://shopify/BulkOperation/del-1');
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

    expect(done?.status).toBe('COMPLETED');
    expect(done?.deleted).toBe(99);
    expect(done?.failedCount).toBe(1);
    expect(done?.errors).toEqual([
      { id: 'gid://shopify/Product/100', message: 'Product is referenced by an order' },
    ]);
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
});
