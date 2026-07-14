import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getShopifyConfig, resetShopifyConfigCache, resolveStoreId } from '../src/config/shopify';

// ─────────────────────────────────────────────────────────────────────────────
// NO SILENT DEFAULT STORE.
//
// getShopifyConfig() used to fall back to stores[0] when no storeId was given. So
// "I forgot to say which store" and "I meant the first store" were the same
// request — and the difference was settled by creating REAL RECORDS IN A REAL
// STORE.
//
// With one user and one store that was merely sloppy. With a shared pool of stores
// and five colleagues it is a way to write a merchant's customers into whichever
// store happens to be listed first, quite possibly the one someone else is mid-QA
// on. It also made the busy-lock ambiguous: a request naming store1 and a request
// naming nothing hit the same shop, so they had to be resolved to one lock key
// before they could contend at all.
//
// An unspecified store is now an error. This test is the tripwire: restoring the
// fallback (an easy, innocent-looking "convenience" change) turns it red.
// ─────────────────────────────────────────────────────────────────────────────

// Tokens must look real (shpat_ prefix) or validateStore rejects the whole config.
const STORES = JSON.stringify([
  { id: 'store1', label: 'First', shop: 'first.myshopify.com', adminToken: 'shpat_fake1' },
  { id: 'store2', label: 'Second', shop: 'second.myshopify.com', adminToken: 'shpat_fake2' },
]);

describe('a store must be named — there is no default', () => {
  beforeEach(() => {
    process.env.SHOPIFY_TEST_STORES = STORES;
    resetShopifyConfigCache();
  });
  afterEach(() => {
    process.env.SHOPIFY_TEST_STORES = '[]';
    resetShopifyConfigCache();
  });

  it('refuses to guess when no store is named, even though stores are configured', () => {
    const result = getShopifyConfig(undefined);

    // The old behaviour returned stores[0] — 'store1' — right here, and the caller
    // went on to import a merchant's data into it.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no shopify store selected/i);
  });

  it('still resolves a store that IS named', () => {
    const result = getShopifyConfig('store2');

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.config.shop).toBe('second.myshopify.com');
  });

  it('names the store it could not find, rather than falling back to another one', () => {
    const result = getShopifyConfig('typo-store');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('typo-store');
  });

  it('resolveStoreId returns null for an unnamed store instead of inventing one', () => {
    // The resume path reads storeId off a DB row, where a LEGACY row (written when
    // the fallback still existed) can hold NULL. Such a row has no store to lock and
    // must not be guessed at — it fails loudly instead.
    expect(resolveStoreId(undefined)).toBeNull();
    expect(resolveStoreId('store1')).toBe('store1');
  });
});
