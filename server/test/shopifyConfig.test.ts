import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getBulkOpsPerStore,
  getShopifyStoresConfig,
  normalizeShop,
  resetShopifyConfigCache,
} from '../src/config/shopify';

// ─────────────────────────────────────────────────────────────────────────────
// SHOPIFY STORE CONFIG: secrets stay out of errors; one shop, one store.
//
// The config error is cached and returned to the browser (GET /api/shopify/stores,
// and every ShopifyConfigError). So whatever goes wrong parsing the env, the
// message must not quote the env — it holds the shared client secret.
//
// All values below are FAKE.
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_SECRET = 'FAKE_SECRET_do_not_echo_12345';

function configError(): string {
  resetShopifyConfigCache();
  const result = getShopifyStoresConfig();
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.error;
}

describe('SHOPIFY_TEST_STORES errors never echo the configured values', () => {
  afterEach(() => {
    process.env.SHOPIFY_TEST_STORES = '[]';
    resetShopifyConfigCache();
  });

  it('malformed JSON names the variable but quotes none of the input', () => {
    // Unquoted secret value: V8's SyntaxError would quote this slice of the input.
    process.env.SHOPIFY_TEST_STORES = `[{"shop":"fake.myshopify.com","clientId":"fake-id","clientSecret":${FAKE_SECRET}}]`;

    const error = configError();

    expect(error).toContain('SHOPIFY_TEST_STORES');
    expect(error).toMatch(/not valid JSON/);
    expect(error).not.toContain('FAKE_SECRET');
    expect(error).not.toContain('clientSecret');
  });

  it('a schema failure on a secret field describes the field, not the value', () => {
    process.env.SHOPIFY_TEST_STORES = JSON.stringify([
      { shop: 'fake.myshopify.com', adminToken: FAKE_SECRET },
    ]);

    const error = configError();

    expect(error).toContain('adminToken');
    expect(error).not.toContain('FAKE_SECRET');
  });

  it('a wrong-type secret describes the type, not the value', () => {
    process.env.SHOPIFY_TEST_STORES = JSON.stringify([
      { shop: 'fake.myshopify.com', clientId: 'fake-id', clientSecret: [FAKE_SECRET] },
    ]);

    const error = configError();

    expect(error).toContain('clientSecret');
    expect(error).not.toContain('FAKE_SECRET');
  });

  it('a bad admin token in the numbered form does not echo the token', () => {
    process.env.SHOPIFY_TEST_STORES = '';
    process.env.SHOPIFY_SHOP_7 = 'fake7.myshopify.com';
    process.env.SHOPIFY_ADMIN_TOKEN_7 = FAKE_SECRET;
    try {
      const error = configError();
      expect(error).toMatch(/shpat_/);
      expect(error).not.toContain('FAKE_SECRET');
    } finally {
      delete process.env.SHOPIFY_SHOP_7;
      delete process.env.SHOPIFY_ADMIN_TOKEN_7;
    }
  });
});

describe('normalizeShop', () => {
  it.each([
    ['fake-store.myshopify.com', 'fake-store.myshopify.com'],
    ['  fake-store.myshopify.com  ', 'fake-store.myshopify.com'],
    ['https://fake-store.myshopify.com/', 'fake-store.myshopify.com'],
    ['http://fake-store.myshopify.com//', 'fake-store.myshopify.com'],
    ['fake-store.myshopify.com/admin', 'fake-store.myshopify.com'],
    ['https://fake-store.myshopify.com/admin/products?x=1', 'fake-store.myshopify.com'],
    ['https://admin.shopify.com/store/fake-store', 'fake-store.myshopify.com'],
    ['https://admin.shopify.com/store/fake-store/products/123', 'fake-store.myshopify.com'],
    ['admin.shopify.com/store/fake-store/', 'fake-store.myshopify.com'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeShop(raw)).toBe(expected);
  });
});

describe('store identity', () => {
  beforeEach(() => resetShopifyConfigCache());
  afterEach(() => {
    process.env.SHOPIFY_TEST_STORES = '[]';
    resetShopifyConfigCache();
  });

  it('keeps the derived id of an already-valid config stable', () => {
    // Ids are lock keys and the storeId on DB rows: an existing config must keep them.
    process.env.SHOPIFY_TEST_STORES = JSON.stringify([
      { shop: 'https://fake-one.myshopify.com/', adminToken: 'shpat_fake1' },
      { shop: 'fake-two.myshopify.com', adminToken: 'shpat_fake2' },
      { id: 'store3', shop: 'fake-three.myshopify.com', adminToken: 'shpat_fake3' },
    ]);

    const result = getShopifyStoresConfig();

    expect(result.ok).toBe(true);
    expect(result.ok && result.stores.map((s) => [s.id, s.shop])).toEqual([
      ['fake-one', 'fake-one.myshopify.com'],
      ['fake-two', 'fake-two.myshopify.com'],
      ['store3', 'fake-three.myshopify.com'],
    ]);
  });

  it('derives the same id from an admin.shopify.com URL as from the domain', () => {
    process.env.SHOPIFY_TEST_STORES = JSON.stringify([
      { shop: 'https://admin.shopify.com/store/fake-one', adminToken: 'shpat_fake1' },
    ]);

    const result = getShopifyStoresConfig();

    expect(result.ok && result.stores[0]).toMatchObject({
      id: 'fake-one',
      shop: 'fake-one.myshopify.com',
    });
  });

  it('rejects one shop listed under two ids, whatever form it is written in', () => {
    process.env.SHOPIFY_TEST_STORES = JSON.stringify([
      { id: 'store1', shop: 'Fake-One.myshopify.com', adminToken: 'shpat_fake1' },
      { id: 'store2', shop: 'https://admin.shopify.com/store/fake-one', adminToken: 'shpat_fake2' },
    ]);

    const error = configError();

    expect(error).toMatch(/configured twice/);
    expect(error).toContain('store1');
    expect(error).toContain('store2');
  });

  it('still rejects a duplicate id', () => {
    process.env.SHOPIFY_TEST_STORES = JSON.stringify([
      { id: 'store1', shop: 'fake-one.myshopify.com', adminToken: 'shpat_fake1' },
      { id: 'store1', shop: 'fake-two.myshopify.com', adminToken: 'shpat_fake2' },
    ]);

    expect(configError()).toMatch(/Duplicate Shopify store id "store1"/);
  });

  it('rejects a whitespace-only shop', () => {
    process.env.SHOPIFY_TEST_STORES = JSON.stringify([
      { shop: '   ', adminToken: 'shpat_fake1' },
    ]);

    expect(configError()).toMatch(/Shop domain is required/);
  });

  it('rejects a whitespace-only shop in the numbered form', () => {
    process.env.SHOPIFY_TEST_STORES = '';
    process.env.SHOPIFY_SHOP_7 = '   ';
    process.env.SHOPIFY_ADMIN_TOKEN_7 = 'shpat_fake7';
    try {
      expect(configError()).toMatch(/Shop domain is required/);
    } finally {
      delete process.env.SHOPIFY_SHOP_7;
      delete process.env.SHOPIFY_ADMIN_TOKEN_7;
    }
  });
});

describe('getBulkOpsPerStore', () => {
  const prev = process.env.BULK_OPS_PER_STORE;
  afterEach(() => {
    if (prev === undefined) delete process.env.BULK_OPS_PER_STORE;
    else process.env.BULK_OPS_PER_STORE = prev;
  });
  const read = (v: string | undefined) => {
    if (v === undefined) delete process.env.BULK_OPS_PER_STORE;
    else process.env.BULK_OPS_PER_STORE = v;
    return getBulkOpsPerStore();
  };

  it('defaults to 5 when unset, empty or non-numeric', () => {
    expect(read(undefined)).toBe(5);
    expect(read('')).toBe(5);
    expect(read('abc')).toBe(5);
  });
  it('clamps to 1..5', () => {
    expect(read('1')).toBe(1);
    expect(read('3')).toBe(3);
    expect(read('0')).toBe(1);
    expect(read('-4')).toBe(1);
    expect(read('99')).toBe(5);
    expect(read('2.7')).toBe(2);
  });
});
