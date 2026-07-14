import { describe, expect, it } from 'vitest';
// Importing prisma FIRST is deliberate: constructing the Prisma client is what
// reloads .env and used to repopulate SHOPIFY_TEST_STORES behind setEnv's back.
// If this guard ever regresses, that import is how it happens.
import '../../src/db/prisma';
import { getSafeShopifyStores, getShopifyConfig } from '../../src/config/shopify';
import { getShopifyClient } from '../../src/services/shopifyClient';

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────────────────────
// THE GUARD ITSELF.
//
// On 2026-07-14 an integration test reached the REAL Shopify test stores and
// created REAL products, because setEnv.ts overrode DATABASE_URL and left the
// Shopify credentials live. This suite makes that failure loud instead of silent:
// if the isolation ever breaks, these go red BEFORE some other test quietly
// mutates a real store.
//
// A test suite that can reach production is not a test suite.
// ─────────────────────────────────────────────────────────────────────────────
runIf('integration tests must not be able to reach real Shopify', () => {
  it('resolves zero configured stores', () => {
    expect(getSafeShopifyStores()).toEqual([]);
  });

  it('cannot resolve config for a store that exists in the real .env', () => {
    const result = getShopifyConfig('store1');
    expect(result.ok).toBe(false);
  });

  it('refuses to build a Shopify client instead of returning a live one', async () => {
    // "No Shopify test stores configured." — a ShopifyConfigError, not a client.
    await expect(getShopifyClient('store1')).rejects.toThrow(/configured/i);
  });

  it('leaks no Shopify credentials into the environment', () => {
    const leaked = Object.entries(process.env)
      .filter(([k, v]) => k.startsWith('SHOPIFY_') && v && v !== '[]')
      .map(([k]) => k);
    expect(leaked).toEqual([]);
  });
});
