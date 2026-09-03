import { afterEach, describe, expect, it, vi } from 'vitest';

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
//   2. Never touch a row without a bulkOperationId. Those have not reached Shopify
//      and belong to resumePendingImports; reconciling them here would at best do
//      nothing and at worst race a second submit onto the shop.
// ─────────────────────────────────────────────────────────────────────────────

const ORIGINAL = { ...process.env };

const findMany = vi.fn();
const productFindMany = vi.fn();
const reconcileCustomer = vi.fn();
const reconcileProduct = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    importRun: { findMany: (...a: unknown[]) => findMany(...a) },
    productImportRun: { findMany: (...a: unknown[]) => productFindMany(...a) },
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

afterEach(() => {
  process.env = { ...ORIGINAL };
  findMany.mockReset();
  productFindMany.mockReset();
  reconcileCustomer.mockReset();
  reconcileProduct.mockReset();
});

describe('sweepRunningImports', () => {
  it('reconciles a run for a store this instance owns', async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([{ id: 'run-1', storeId: 'mine' }]);
    productFindMany.mockResolvedValue([]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    expect(reconcileCustomer).toHaveBeenCalledWith('run-1');
  });

  it("SKIPS a colleague's run — the store is not in this process", async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([{ id: 'their-run', storeId: 'someone-elses-store' }]);
    productFindMany.mockResolvedValue([]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    // Their own instance will finish it. Ours must stay out of the way and, above
    // all, not log a failure every minute for a run that is perfectly healthy.
    expect(reconcileCustomer).not.toHaveBeenCalled();
  });

  it('only asks for rows that already reached Shopify', async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([]);
    productFindMany.mockResolvedValue([]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    // A row without a bulk op id belongs to resumePendingImports, not here.
    for (const call of [findMany.mock.calls[0][0], productFindMany.mock.calls[0][0]]) {
      expect(call.where.bulkOperationId).toEqual({ not: null });
      expect(call.where.status.notIn).toContain('COMPLETED');
      expect(call.where.status.notIn).toContain('FAILED');
    }
  });

  it('one unreachable store does not stop the others', async () => {
    configureStores('[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]');
    findMany.mockResolvedValue([
      { id: 'boom', storeId: 'mine' },
      { id: 'fine', storeId: 'mine' },
    ]);
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
    productFindMany.mockResolvedValue([{ id: 'prod-1', storeId: 'mine' }]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    expect(reconcileProduct).toHaveBeenCalledWith('prod-1');
  });

  it('with NO usable store config, attempts rather than silently skipping', async () => {
    // resolveStoreId returns null for everything alike here. Skipping on that basis
    // would turn a misconfiguration into a no-op with no error anywhere — the exact
    // failure importResume.service.ts documents. Better to try and fail loudly.
    delete process.env.SHOPIFY_TEST_STORES;
    findMany.mockResolvedValue([{ id: 'run-1', storeId: 'some-store' }]);
    productFindMany.mockResolvedValue([]);

    const { sweepRunningImports } = await load();
    await sweepRunningImports();

    expect(reconcileCustomer).toHaveBeenCalledWith('run-1');
  });
});
