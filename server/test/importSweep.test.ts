import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// THE SWEEP THAT FINISHES IMPORTS NOBODY IS WATCHING.
//
// Imports finalize on poll. An import whose watcher closed the tab sits RUNNING
// with Shopify already done — misreported in the shared history, and holding that
// store's busy-lock until the 30-minute TTL blocks the next import to the shop.
// A real 14,229-row import sat that way for two hours and finalized in three
// seconds the moment anything polled it.
//
// Two things this must get right, and both are about a SHARED database:
//
//   1. Only sweep rows for stores this instance has credentials for. Every
//      instance sees every colleague's runs. Reconciling one we hold no token for
//      cannot corrupt anything, but it would have seven instances logging a
//      failure a minute for every run the eighth owns — burying the real ones.
//
//   2. Never touch a single-store row without a bulkOperationId. Those have not
//      reached Shopify and belong to resumePendingImports; reconciling them here
//      would at best do nothing and at worst race a second submit onto the shop.
//      A batch PARENT never has an op id of its own (its ops live on its jobs), so
//      it is swept for having jobs — filtering on the op id alone skipped every
//      batch, leaving it RUNNING and holding all of its stores.
// ─────────────────────────────────────────────────────────────────────────────

const ORIGINAL = { ...process.env };

const findMany = vi.fn();
const productFindMany = vi.fn();
const reconcileCustomer = vi.fn();
const reconcileProduct = vi.fn();
// Settling abandoned submits reads all four PENDING-capable tables. Each gets its
// own fake so a test can seed one and see exactly what was written.
const pendingFind = { run: vi.fn(), job: vi.fn(), productRun: vi.fn(), productJob: vi.fn() };
const pendingUpdate = vi.fn();

/** The sweep's own query and the settling query share a delegate; the settling
 *  one is told apart by its PENDING filter. */
function delegate(sweepFind: (args: unknown) => unknown, pending: (args: unknown) => unknown) {
  return {
    findMany: (args: { where: { status: unknown } }) =>
      args.where.status === 'PENDING' ? pending(args) : sweepFind(args),
    updateMany: (args: unknown) => pendingUpdate(args),
  };
}

vi.mock('../src/db/prisma', () => ({
  default: {
    importRun: delegate((a) => findMany(a), (a) => pendingFind.run(a)),
    importBatchJob: delegate(() => [], (a) => pendingFind.job(a)),
    productImportRun: delegate((a) => productFindMany(a), (a) => pendingFind.productRun(a)),
    productImportJob: delegate(() => [], (a) => pendingFind.productJob(a)),
  },
}));
vi.mock('../src/services/shopifyImport.service', () => ({
  reconcileImportRun: (id: string) => reconcileCustomer(id),
}));
vi.mock('../src/services/productImport.service', () => ({
  reconcileProductImportRun: (id: string) => reconcileProduct(id),
}));

/** One instance configured for a single store, exactly like a deployed SE. */
function configureStores(json: string): void {
  process.env.SHOPIFY_TEST_STORES = json;
}

async function load() {
  vi.resetModules();
  const { resetShopifyConfigCache } = await import('../src/config/shopify');
  resetShopifyConfigCache();
  return import('../src/services/importSweep.service');
}

/** A sweep row as the sweep selects it. A single-store run has no jobs. */
const single = (id: string, storeId: string | null) => ({ id, storeId, batchJobs: [] });
const batch = (id: string, jobStores: string[]) => ({
  id,
  storeId: null,
  batchJobs: jobStores.map((storeId) => ({ storeId })),
});

beforeEach(() => {
  for (const f of Object.values(pendingFind)) f.mockResolvedValue([]);
  pendingUpdate.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  findMany.mockReset();
  productFindMany.mockReset();
  reconcileCustomer.mockReset();
  reconcileProduct.mockReset();
  for (const f of Object.values(pendingFind)) f.mockReset();
  pendingUpdate.mockReset();
});

describe('sweepRunningImports', () => {
  it('reconciles a run for a store this instance owns', async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([single('run-1', 'mine')]);
    productFindMany.mockResolvedValue([]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    expect(reconcileCustomer).toHaveBeenCalledWith('run-1');
  });

  it("SKIPS a colleague's run — the store is not in this process", async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([single('their-run', 'someone-elses-store')]);
    productFindMany.mockResolvedValue([]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    // Their own instance will finish it. Ours must stay out of the way and, above
    // all, not log a failure every minute for a run that is perfectly healthy.
    expect(reconcileCustomer).not.toHaveBeenCalled();
  });

  it('only asks for rows that reached Shopify, or are batch parents', async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([]);
    productFindMany.mockResolvedValue([]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    // A single run without a bulk op id belongs to resumePendingImports, not here.
    // A batch parent never has one, and is swept for having jobs.
    for (const call of [findMany.mock.calls[0][0], productFindMany.mock.calls[0][0]]) {
      expect(call.where.OR).toEqual([
        { bulkOperationId: { not: null } },
        { batchJobs: { some: {} } },
      ]);
      expect(call.where.status.notIn).toContain('COMPLETED');
      expect(call.where.status.notIn).toContain('FAILED');
    }
  });

  it('sweeps a batch parent — it has no op id of its own, only jobs', async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([batch('cust-batch', ['mine', 'someone-elses-store'])]);
    productFindMany.mockResolvedValue([batch('prod-batch', ['mine'])]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    // Ours because ONE of its stores is ours: we advance that job, and the
    // reconcile leaves the colleague's job to them (it skips, never fails).
    expect(reconcileCustomer).toHaveBeenCalledWith('cust-batch');
    expect(reconcileProduct).toHaveBeenCalledWith('prod-batch');
  });

  it("SKIPS a colleague's batch — none of its stores is in this process", async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([batch('their-batch', ['someone-elses-store', 'another'])]);
    productFindMany.mockResolvedValue([]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    expect(reconcileCustomer).not.toHaveBeenCalled();
  });

  it('one unreachable store does not stop the others', async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([single('boom', 'mine'), single('fine', 'mine')]);
    productFindMany.mockResolvedValue([]);
    reconcileCustomer.mockImplementation((id: string) => {
      if (id === 'boom') return Promise.reject(new Error('Shopify unreachable'));
      return Promise.resolve(null);
    });

    const { sweepRunningImports } = await load();
    await expect(sweepRunningImports()).resolves.toBeUndefined();
    expect(reconcileCustomer).toHaveBeenCalledWith('fine');
  });

  it('sweeps products too — the flows are twins', async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([]);
    productFindMany.mockResolvedValue([single('prod-1', 'mine')]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    expect(reconcileProduct).toHaveBeenCalledWith('prod-1');
  });

  it('with NO usable store config, attempts rather than silently skipping', async () => {
    // resolveStoreId returns null for everything alike here. Skipping on that basis
    // would turn a misconfiguration into a no-op with no error anywhere — the exact
    // failure importResume.service.ts documents. Better to try and log loudly (the
    // reconcile itself never FAILS a run for want of a client — importReconcile).
    delete process.env.SHOPIFY_TEST_STORES;
    findMany.mockResolvedValue([single('run-1', 'some-store')]);
    productFindMany.mockResolvedValue([]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    expect(reconcileCustomer).toHaveBeenCalledWith('run-1');
  });
});

// ── ambiguous submits: held while they might be live, settled after the TTL ──
describe('sweepRunningImports — settling abandoned submits', () => {
  const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
  const TTL = 30 * 60 * 1000;

  it('fails an own PENDING row whose submit outcome has been unknown past the lock TTL', async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([]);
    productFindMany.mockResolvedValue([]);
    const old = new Date(NOW - TTL - 1);
    pendingFind.job.mockResolvedValue([
      { id: 'job-mine', storeId: 'mine', createdAt: new Date(0), submitAttemptedAt: old },
      { id: 'job-theirs', storeId: 'someone-elses-store', createdAt: new Date(0), submitAttemptedAt: old },
    ]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports(NOW);

    // Only rows attempted before NOW - TTL: anything younger may be a submit still
    // in flight, or an op whose store must stay held.
    const where = pendingFind.job.mock.calls[0][0].where;
    expect(where.submitAttemptedAt.lt).toEqual(new Date(NOW - TTL));

    // Ours is failed with the "outcome unknown" reason; the colleague's is theirs.
    expect(pendingUpdate).toHaveBeenCalledTimes(1);
    const update = pendingUpdate.mock.calls[0][0];
    expect(update.where).toMatchObject({ id: 'job-mine', status: 'PENDING' });
    expect(update.data.status).toBe('FAILED');
    expect(update.data.error).toMatch(/outcome unknown/i);
  });

  it('settles nothing when this instance cannot judge ownership', async () => {
    delete process.env.SHOPIFY_TEST_STORES;
    findMany.mockResolvedValue([]);
    productFindMany.mockResolvedValue([]);
    pendingFind.run.mockResolvedValue([
      { id: 'run-x', storeId: 'some-store', createdAt: new Date(0), submitAttemptedAt: new Date(0) },
    ]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports(NOW);

    // Writing FAILED is not something to do on a guess about whose row it is.
    expect(pendingUpdate).not.toHaveBeenCalled();
  });
});
