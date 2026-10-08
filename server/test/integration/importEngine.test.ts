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
const fakeClient2 = {
  ...fakeClient,
  shop: 'qa2.example.com',
  verifyConnection: async () => ({ ok: true, shop: 'qa2.example.com' }),
};

const runBulkMutation = vi.fn();
const fetchBulkOperationState = vi.fn();
/** Every JSONL staged so far, by the staged path handed back for it. */
const staged = new Map<string, string>();

vi.mock('../../src/services/shopifyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyClient')>();
  return {
    ...actual,
    // store2 is its own shop, so a multi-store parent's joined domain list shows.
    getShopifyClient: async (storeId?: string) => (storeId === 'store2' ? fakeClient2 : fakeClient),
  };
});
vi.mock('../../src/services/shopifyBulk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyBulk')>();
  return {
    ...actual,
    stagedUpload: async (_c: unknown, jsonl: string) => {
      const path = `staged/${staged.size}`;
      staged.set(path, jsonl);
      return path;
    },
    runBulkMutation: (...a: unknown[]) => runBulkMutation(...a),
    fetchBulkOperationState: (_c: unknown, id: string) => fetchBulkOperationState(id),
  };
});

const prisma = (await import('../../src/db/prisma')).default;
const { resetDb } = await import('./resetDb');
const { startCustomerImport, startBatchImport, reconcileImportRun } = await import(
  '../../src/services/shopifyImport.service'
);
const { startProductImport, reconcileProductImportRun } = await import(
  '../../src/services/productImport.service'
);
const { ShopifyOutcomeUnknownError } = await import('../../src/services/shopifyClient');
const { shareOwner } = await import('../../src/services/storeLock.service');

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
    staged.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  // ── #3: an ambiguous submit must not free the store under a live op ─────────
  it('product: an ambiguous submit stays PENDING and keeps the store held', async () => {
    runBulkMutation.mockRejectedValue(new ShopifyOutcomeUnknownError('HTTP 502. Not re-sent.'));

    const result = await startProductImport(await seedUpload(['alpha']), 'store1');
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/may or may not be running/i);

    const runs = await prisma.productImportRun.findMany();
    expect(runs).toHaveLength(1);
    // Non-terminal → its lock is NOT self-healing (holderIsFinished) and the store
    // stays reserved until the TTL, when the sweep settles it as outcome-unknown.
    expect(runs[0].status).toBe('PENDING');
    expect(runs[0].submitAttemptedAt).not.toBeNull();
    const lock = await prisma.storeLock.findUnique({ where: { storeId: 'store1' } });
    expect(lock?.ownerId).toBe(runs[0].id);
  });

  // A single-store customer import is a one-store batch: the outcome lands on its
  // job, and the store's SHARE (not the job) holds the lock.
  it('customer: an ambiguous submit stays PENDING and keeps the store held', async () => {
    runBulkMutation.mockRejectedValue(new ShopifyOutcomeUnknownError('HTTP 502. Not re-sent.'));

    const result = await startCustomerImport(await seedValidation(1), 'store1');
    expect(result).toMatchObject({ ok: true });
    const parentId = (result as { importRunId: string }).importRunId;

    const jobs = await prisma.importBatchJob.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('PENDING');
    expect(jobs[0].submitAttemptedAt).not.toBeNull();
    expect(jobs[0].error).toMatch(/may or may not be running/i);
    const lock = await prisma.storeLock.findUnique({ where: { storeId: 'store1' } });
    expect(lock).toMatchObject({ ownerType: 'IMPORT_STORE_SHARE', ownerId: shareOwner(parentId, 'store1') });
  });

  it('a definite submit failure still fails the job and frees the store at once', async () => {
    runBulkMutation.mockRejectedValue(new Error('bulkOperationRunMutation failed: bad mutation'));

    const result = await startCustomerImport(await seedValidation(1), 'store1');
    expect(result).toMatchObject({ ok: true });
    const [job] = await prisma.importBatchJob.findMany();
    expect(job.status).toBe('FAILED');
    expect(job.error).toContain('bad mutation');
    // Shopify answered "no", so nothing is running: the row must not read as the
    // outcome-unknown kind, which would hold the store to the TTL.
    expect(job.submitAttemptedAt).toBeNull();
    expect(await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })).toBeNull();

    // The parent rolls up on the first poll.
    const feedback = await reconcileImportRun((result as { importRunId: string }).importRunId);
    expect(feedback).toMatchObject({ status: 'FAILED' });
    expect(feedback!.error).toContain('bad mutation');
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
    // One op for the whole file, so the partial file below covers it.
    vi.stubEnv('BULK_OPS_PER_STORE', '1');
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
      // A batch parent names the store its failed job ran on.
      error: 'qa1.example.com: Bulk operation FAILED (INTERNAL_SERVER_ERROR).',
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

// ─────────────────────────────────────────────────────────────────────────────
// A STORE'S SHARE RUNS AS k CONCURRENT BULK OPS (customers).
//
// Every customer import — single-store included — goes through the batch path and
// splits each store's share across k = min(BULK_OPS_PER_STORE, rows per store) ops.
// The jobs of one store hold ONE lock between them (the share), so the store stays
// busy until the LAST of them is terminal, and the parent rolls up only then.
// ─────────────────────────────────────────────────────────────────────────────

/** Submits succeed; each op id names the staged file it was submitted with. */
function submitByStagedPath(): void {
  runBulkMutation.mockImplementation(async (_c: unknown, _m: unknown, path: string) => `op:${path}`);
}

/**
 * Ops in `done` are COMPLETED, the rest RUNNING. A completed op's result file is
 * built from the JSONL it was SUBMITTED with: line i of the file accepts the customer
 * on line i, with an id derived from that customer's email (p<n>@ → Customer/<n>).
 * If the reconcile mapped the results onto a different slice than the job launched
 * with, every id would land on the wrong row number.
 */
function opsComplete(done: (opId: string) => boolean): void {
  fetchBulkOperationState.mockImplementation(async (opId: string) =>
    done(opId)
      ? opState('COMPLETED', { id: opId, url: `https://example.com/${encodeURIComponent(opId)}` })
      : opState('RUNNING', { id: opId }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const opId = decodeURIComponent(url.split('/').pop()!);
      const jsonl = staged.get(opId.replace(/^op:/, ''))!;
      const body = jsonl
        .split('\n')
        .map((line, i) => {
          const n = /p(\d+)@/.exec(line)![1];
          return JSON.stringify({
            __lineNumber: i,
            data: { customerCreate: { customer: { id: `gid://shopify/Customer/${n}` }, userErrors: [] } },
          });
        })
        .join('\n');
      return { status: 200, text: async () => body } as unknown as Response;
    }),
  );
}

const jobsOf = (importRunId: string) =>
  prisma.importBatchJob.findMany({ where: { importRunId }, orderBy: { batchIndex: 'asc' } });

runIf('customer import: k bulk ops per store', () => {
  beforeEach(async () => {
    await resetDb();
    runBulkMutation.mockReset();
    fetchBulkOperationState.mockReset();
    staged.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    submitByStagedPath();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it('a single-store start with 12 rows runs as 5 jobs on that store, under one share lock', async () => {
    const result = await startCustomerImport(await seedValidation(12), 'store1');
    expect(result).toMatchObject({ ok: true });
    const parentId = (result as { importRunId: string }).importRunId;

    const parent = await prisma.importRun.findUniqueOrThrow({ where: { id: parentId } });
    expect(parent).toMatchObject({ storeId: null, shopDomain: 'qa1.example.com', status: 'RUNNING' });

    const jobs = await jobsOf(parentId);
    expect(jobs.map((j) => j.storeId)).toEqual(Array(5).fill('store1'));
    expect(jobs.map((j) => j.batchIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(jobs.every((j) => j.batchCount === 5)).toBe(true);
    expect(jobs.map((j) => j.rowCount)).toEqual([3, 3, 2, 2, 2]);
    expect(jobs.every((j) => j.status === 'RUNNING')).toBe(true);
    expect(runBulkMutation).toHaveBeenCalledTimes(5);

    const locks = await prisma.storeLock.findMany();
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({
      storeId: 'store1',
      ownerType: 'IMPORT_STORE_SHARE',
      ownerId: shareOwner(parentId, 'store1'),
    });
  });

  it('a 3-row file runs as 3 jobs, one row each', async () => {
    const result = await startCustomerImport(await seedValidation(3), 'store1');
    const jobs = await jobsOf((result as { importRunId: string }).importRunId);
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.rowCount)).toEqual([1, 1, 1]);
    expect(jobs.every((j) => j.batchCount === 3)).toBe(true);
  });

  it('an op left running on the shop takes its slot out of k', async () => {
    // Three bulk mutations already RUNNING (an orphan from a crash, say): five per
    // shop is Shopify's cap, so only two more fit.
    vi.spyOn(fakeClient, 'query').mockResolvedValue({
      bulkOperations: { nodes: [{ id: 'a', status: 'RUNNING' }, { id: 'b', status: 'RUNNING' }, { id: 'c', status: 'RUNNING' }] },
    } as never);
    const result = await startCustomerImport(await seedValidation(12), 'store1');
    const jobs = await jobsOf((result as { importRunId: string }).importRunId);
    expect(jobs).toHaveLength(2);
  });

  it('the store stays busy until the LAST job is terminal; the parent completes only then', async () => {
    const validationId = await seedValidation(12);
    const result = await startCustomerImport(validationId, 'store1');
    const parentId = (result as { importRunId: string }).importRunId;
    const jobs = await jobsOf(parentId);
    const lastOp = jobs[4].bulkOperationId!;

    // Four of five done.
    opsComplete((opId) => opId !== lastOp);
    let feedback = await reconcileImportRun(parentId);
    expect(feedback).toMatchObject({ status: 'RUNNING' });
    expect((await jobsOf(parentId)).map((j) => j.status)).toEqual([
      'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'RUNNING',
    ]);
    expect(await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })).not.toBeNull();
    // Still held for real: a colleague is refused.
    expect(await startCustomerImport(await seedValidation(1), 'store1')).toMatchObject({ ok: false, busy: true });

    // The last one lands.
    opsComplete(() => true);
    feedback = await reconcileImportRun(parentId);
    expect(feedback).toMatchObject({ status: 'COMPLETED', successCount: 12, errorCount: 0, totalRows: 12 });
    expect(await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })).toBeNull();

    // Each job's results were mapped onto exactly the slice it launched with: the
    // customer created from row n's email (p<n-2>@) is recorded against row n.
    const results = await prisma.importRowResult.findMany({ where: { importRunId: parentId } });
    expect(results).toHaveLength(12);
    for (const r of results) {
      expect(r.shopifyCustomerId).toBe(`gid://shopify/Customer/${r.rowNumber - 2}`);
    }
  });

  it('a multi-store start plans stores × k jobs, each block of k on its own store', async () => {
    const result = await startBatchImport(await seedValidation(20), ['store1', 'store2']);
    const parentId = (result as { importRunId: string }).importRunId;

    const jobs = await jobsOf(parentId);
    expect(jobs).toHaveLength(10);
    expect(jobs.map((j) => j.storeId)).toEqual([...Array(5).fill('store1'), ...Array(5).fill('store2')]);
    expect(jobs.every((j) => j.batchCount === 10 && j.rowCount === 2)).toBe(true);

    const parent = await prisma.importRun.findUniqueOrThrow({ where: { id: parentId } });
    expect(parent.shopDomain).toBe('qa1.example.com, qa2.example.com');
    const locks = await prisma.storeLock.findMany({ orderBy: { storeId: 'asc' } });
    expect(locks.map((l) => [l.storeId, l.ownerId])).toEqual([
      ['store1', shareOwner(parentId, 'store1')],
      ['store2', shareOwner(parentId, 'store2')],
    ]);
  });

  it('BULK_OPS_PER_STORE=1 is one job per store (the old shape)', async () => {
    vi.stubEnv('BULK_OPS_PER_STORE', '1');
    const result = await startBatchImport(await seedValidation(20), ['store1', 'store2']);
    const jobs = await jobsOf((result as { importRunId: string }).importRunId);
    expect(jobs.map((j) => [j.storeId, j.batchIndex, j.batchCount, j.rowCount])).toEqual([
      ['store1', 0, 2, 10],
      ['store2', 1, 2, 10],
    ]);
  });

  it('jobs that fail at launch free the share only once every sibling is terminal', async () => {
    // Two of three submits are refused outright; the third reaches Shopify.
    let n = 0;
    runBulkMutation.mockImplementation(async (_c: unknown, _m: unknown, path: string) => {
      n++;
      if (n <= 2) throw new Error('bulkOperationRunMutation failed: refused');
      return `op:${path}`;
    });
    const result = await startCustomerImport(await seedValidation(3), 'store1');
    const parentId = (result as { importRunId: string }).importRunId;

    const statuses = (await jobsOf(parentId)).map((j) => j.status).sort();
    expect(statuses).toEqual(['FAILED', 'FAILED', 'RUNNING']);
    // The running sibling still holds the store.
    expect(await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })).not.toBeNull();

    opsComplete(() => true);
    const feedback = await reconcileImportRun(parentId);
    expect(feedback).toMatchObject({ status: 'FAILED', successCount: 1 });
    expect(await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })).toBeNull();
  });
});
