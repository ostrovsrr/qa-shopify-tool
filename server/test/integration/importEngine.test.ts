import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// THE IMPORT ENGINE against a real database, for both flows (they are twins):
//
//   • an ambiguous bulk submit keeps the run PENDING and its store HELD;
//   • a single-store run whose op vanished is FAILED and its store freed, not left
//     RUNNING forever;
//   • an op that ended FAILED still reports the records it created (partialDataUrl);
//   • a large batch job's results are chunked inside a long transaction;
//   • the feedback payload — now aggregated in SQL — keeps its exact shape, and a
//     single-store run is labelled with its shop domain, not its store id.
//
// Shopify is faked at the module boundary (as storeLock.test.ts does); result
// files are served by a stubbed fetch. Nothing here reaches a real store.
// ─────────────────────────────────────────────────────────────────────────────

const fakeClient = {
  shop: 'qa1.example.com',
  verifyConnection: async () => ({ ok: true, shop: 'qa1.example.com' }),
  query: async () => ({ locations: { nodes: [] }, metafieldDefinitions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }),
};

const runBulkMutation = vi.fn();
const fetchBulkOperationState = vi.fn();

vi.mock('../../src/services/shopifyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyClient')>();
  return { ...actual, getShopifyClient: async () => fakeClient };
});
vi.mock('../../src/services/shopifyBulk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyBulk')>();
  return {
    ...actual,
    stagedUpload: async () => 'staged/path',
    runBulkMutation: (...a: unknown[]) => runBulkMutation(...a),
    fetchBulkOperationState: (_c: unknown, id: string) => fetchBulkOperationState(id),
  };
});

const prisma = (await import('../../src/db/prisma')).default;
const { resetDb } = await import('./resetDb');
const { startCustomerImport, reconcileImportRun } = await import(
  '../../src/services/shopifyImport.service'
);
const { startProductImport, reconcileProductImportRun } = await import(
  '../../src/services/productImport.service'
);
const { ShopifyOutcomeUnknownError } = await import('../../src/services/shopifyClient');

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** Serve a result file at any URL. */
function serveResults(lines: Record<string, unknown>[]): void {
  const body = lines.map((l) => JSON.stringify(l)).join('\n');
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, text: async () => body }) as unknown as Response));
}

const opState = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'gid://shopify/BulkOperation/1',
  status,
  errorCode: null,
  objectCount: '0',
  url: null,
  partialDataUrl: null,
  ...extra,
});

async function seedValidation(rows: number): Promise<string> {
  const validationId = uuidv4();
  await prisma.validationRun.create({
    data: {
      id: validationId,
      fileName: 'customers.csv',
      fileType: 'CUSTOMER',
      totalRows: rows,
      errors: 0,
      originalRows: {
        create: Array.from({ length: rows }, (_, i) => ({
          id: uuidv4(),
          rowNumber: i + 2,
          data: { 'First Name': `P${i}`, 'Last Name': 'Test', Email: `p${i}@example.com` },
        })),
      },
    },
  });
  return validationId;
}

async function seedUpload(handles: string[]): Promise<string> {
  const uploadId = uuidv4();
  await prisma.productUploadRun.create({
    data: {
      id: uploadId,
      fileName: 'products.csv',
      productCount: handles.length,
      originalRows: {
        create: handles.map((h, i) => ({ id: uuidv4(), rowNumber: i + 1, data: { Handle: h, Title: h } })),
      },
    },
  });
  return uploadId;
}

const customerOk = (i: number) => ({
  __lineNumber: i,
  data: { customerCreate: { customer: { id: `gid://shopify/Customer/${i}` }, userErrors: [] } },
});
const customerTaken = (i: number) => ({
  __lineNumber: i,
  data: { customerCreate: { customer: null, userErrors: [{ field: ['input', 'email'], message: 'Email has already been taken' }] } },
});
const productOk = (i: number) => ({
  __lineNumber: i,
  data: { productSet: { product: { id: `gid://shopify/Product/${i}` }, userErrors: [] } },
});
const productRejected = (i: number, message: string) => ({
  __lineNumber: i,
  data: { productSet: { product: null, userErrors: [{ code: 'INVALID', field: ['input', 'title'], message }] } },
});

runIf('import engine', () => {
  beforeEach(async () => {
    await resetDb();
    runBulkMutation.mockReset();
    fetchBulkOperationState.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  // ── #3: an ambiguous submit must not free the store under a live op ─────────
  it.each([
    ['customer', async () => startCustomerImport(await seedValidation(1), 'store1'), 'importRun'],
    ['product', async () => startProductImport(await seedUpload(['alpha']), 'store1'), 'productImportRun'],
  ] as const)('%s: an ambiguous submit stays PENDING and keeps the store held', async (_, start, table) => {
    runBulkMutation.mockRejectedValue(new ShopifyOutcomeUnknownError('HTTP 502. Not re-sent.'));

    const result = await start();
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/may or may not be running/i);

    const runs = await (prisma[table] as typeof prisma.importRun).findMany();
    expect(runs).toHaveLength(1);
    // Non-terminal → its lock is NOT self-healing (holderIsFinished) and the store
    // stays reserved until the TTL, when the sweep settles it as outcome-unknown.
    expect(runs[0].status).toBe('PENDING');
    expect(runs[0].submitAttemptedAt).not.toBeNull();
    const lock = await prisma.storeLock.findUnique({ where: { storeId: 'store1' } });
    expect(lock?.ownerId).toBe(runs[0].id);
  });

  it('a definite submit failure still fails the run and frees the store at once', async () => {
    runBulkMutation.mockRejectedValue(new Error('bulkOperationRunMutation failed: bad mutation'));

    const result = await startCustomerImport(await seedValidation(1), 'store1');
    expect(result).toMatchObject({ ok: false });
    const [run] = await prisma.importRun.findMany();
    expect(run.status).toBe('FAILED');
    expect(await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })).toBeNull();
  });

  // ── #5: single-store reconcile is error-isolated and bounded ────────────────
  it.each([
    ['customer', async () => startCustomerImport(await seedValidation(1), 'store1'), reconcileImportRun, 'importRun'],
    ['product', async () => startProductImport(await seedUpload(['alpha']), 'store1'), reconcileProductImportRun, 'productImportRun'],
  ] as const)('%s: a vanished op FAILS the single run and frees its store', async (_, start, reconcile, table) => {
    runBulkMutation.mockResolvedValue('gid://shopify/BulkOperation/404');
    const { importRunId } = (await start()) as { importRunId: string };
    const { BulkOperationNotFoundError } = await import('../../src/services/shopifyBulk');
    fetchBulkOperationState.mockRejectedValue(new BulkOperationNotFoundError('gid://shopify/BulkOperation/404'));

    // Used to throw out of the poll and leave the run RUNNING, store held, forever.
    await expect(reconcile(importRunId)).resolves.not.toBeNull();

    const run = await (prisma[table] as typeof prisma.importRun).findUniqueOrThrow({ where: { id: importRunId } });
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatch(/not found/i);
    expect(await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })).toBeNull();
  });

  it('a transient poll error leaves the single run RUNNING and does not throw', async () => {
    runBulkMutation.mockResolvedValue('gid://shopify/BulkOperation/1');
    const { importRunId } = (await startCustomerImport(await seedValidation(1), 'store1')) as { importRunId: string };
    const { ShopifyApiError } = await import('../../src/services/shopifyClient');
    fetchBulkOperationState.mockRejectedValue(new ShopifyApiError('HTTP 503'));

    await expect(reconcileImportRun(importRunId)).resolves.not.toBeNull();
    expect((await prisma.importRun.findUniqueOrThrow({ where: { id: importRunId } })).status).toBe('RUNNING');
  });

  // ── #6 + #7: partial results ingested; single-store label is the domain ─────
  it('customer: an op that ended FAILED reports what it created, keeping FAILED', async () => {
    runBulkMutation.mockResolvedValue('gid://shopify/BulkOperation/1');
    const { importRunId } = (await startCustomerImport(await seedValidation(3), 'store1')) as { importRunId: string };
    fetchBulkOperationState.mockResolvedValue(
      opState('FAILED', { errorCode: 'INTERNAL_SERVER_ERROR', partialDataUrl: 'https://example.com/partial' }),
    );
    // Shopify got through the first two lines before failing.
    serveResults([customerOk(0), customerTaken(1)]);

    const feedback = await reconcileImportRun(importRunId);

    expect(feedback).toMatchObject({
      status: 'FAILED',
      error: 'Bulk operation FAILED (INTERNAL_SERVER_ERROR).',
      successCount: 1,
      errorCount: 1,
      totalRows: 2,
    });
    expect(feedback!.rejectedRows).toEqual([
      { rowNumber: 3, shopifyField: 'email', shopifyCode: 'TAKEN', message: 'Email has already been taken' },
    ]);
    // Single-store run: the store is labelled with its domain, not "store1".
    expect(feedback!.perStore).toEqual([
      { storeId: 'store1', shopDomain: 'qa1.example.com', total: 2, accepted: 1, rejected: 1 },
    ]);
  });

  it('product: same — partial results kept, status FAILED, store labelled by domain', async () => {
    runBulkMutation.mockResolvedValue('gid://shopify/BulkOperation/1');
    const { importRunId } = (await startProductImport(await seedUpload(['alpha', 'beta', 'gamma']), 'store1')) as {
      importRunId: string;
    };
    fetchBulkOperationState.mockResolvedValue(
      opState('CANCELED', { partialDataUrl: 'https://example.com/partial' }),
    );
    serveResults([productOk(0), productRejected(1, 'Title is too long')]);

    const feedback = await reconcileProductImportRun(importRunId);

    expect(feedback).toMatchObject({
      status: 'CANCELED',
      error: 'Bulk operation CANCELED.',
      totalProducts: 2,
      accepted: 1,
      rejected: 1,
    });
    expect(feedback!.rejectionGroups).toEqual([
      {
        shopifyField: 'title',
        shopifyCode: 'INVALID',
        count: 1,
        sampleMessages: ['Title is too long'],
        sampleHandles: ['beta'],
        hint: null,
      },
    ]);
    expect(feedback!.perStore).toEqual([
      { storeId: 'store1', shopDomain: 'qa1.example.com', total: 2, accepted: 1, rejected: 1 },
    ]);
  });

  // ── #1: the batch-job merge chunks and gets the long transaction budget ─────
  it('customer: a batch job with more results than one INSERT chunk merges completely', async () => {
    const ROWS = 5200; // > the 5000-row chunk
    const validationId = await seedValidation(ROWS);
    const parentId = uuidv4();
    const jobId = uuidv4();
    await prisma.importRun.create({
      data: {
        id: parentId,
        validationId,
        storeId: null,
        shopDomain: 'qa1.example.com',
        status: 'RUNNING',
        batchJobs: {
          create: [{
            id: jobId,
            storeId: 'store1',
            shopDomain: 'qa1.example.com',
            batchIndex: 0,
            batchCount: 1,
            bulkOperationId: 'gid://shopify/BulkOperation/1',
            status: 'RUNNING',
            rowCount: ROWS,
            submitAttemptedAt: new Date(),
          }],
        },
      },
    });
    fetchBulkOperationState.mockResolvedValue(opState('COMPLETED', { url: 'https://example.com/r' }));
    serveResults(Array.from({ length: ROWS }, (_, i) => customerOk(i)));

    const feedback = await reconcileImportRun(parentId);

    expect(feedback).toMatchObject({ status: 'COMPLETED', successCount: ROWS, errorCount: 0, totalRows: ROWS });
    expect(await prisma.importRowResult.count({ where: { importRunId: parentId } })).toBe(ROWS);
  }, 120_000);
});
