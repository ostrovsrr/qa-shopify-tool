import { describe, expect, it } from 'vitest';
import { batchStoresOf } from '../src/services/importFeedback.service';

// A parallel import reopened from History while still RUNNING has no row results
// yet, so perStore is empty and the run's own storeId is null. batchStores is
// what the UI restores the store selection from — it must come from the job
// rows, in batch order, regardless of the order the database returned them in.
describe('batchStoresOf', () => {
  it('lists every job store in batch order', () => {
    expect(
      batchStoresOf([
        { storeId: 'store2', shopDomain: 'two.myshopify.com', batchIndex: 1 },
        { storeId: 'store1', shopDomain: 'one.myshopify.com', batchIndex: 0 },
      ]),
    ).toEqual([
      { storeId: 'store1', shopDomain: 'one.myshopify.com' },
      { storeId: 'store2', shopDomain: 'two.myshopify.com' },
    ]);
  });

  // A store's share runs as several jobs; the UI restores STORES, not ops.
  it('lists a store once however many of its jobs there are', () => {
    expect(
      batchStoresOf([
        { storeId: 'store1', shopDomain: 'one.myshopify.com', batchIndex: 1 },
        { storeId: 'store2', shopDomain: 'two.myshopify.com', batchIndex: 2 },
        { storeId: 'store1', shopDomain: 'one.myshopify.com', batchIndex: 0 },
        { storeId: 'store2', shopDomain: 'two.myshopify.com', batchIndex: 3 },
      ]),
    ).toEqual([
      { storeId: 'store1', shopDomain: 'one.myshopify.com' },
      { storeId: 'store2', shopDomain: 'two.myshopify.com' },
    ]);
  });

  it('is empty for a single-store run (no batch jobs)', () => {
    expect(batchStoresOf([])).toEqual([]);
  });
});
