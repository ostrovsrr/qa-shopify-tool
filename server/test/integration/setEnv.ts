// Runs (via setupFiles) before any test module — and therefore before the
// Prisma client is constructed — so Prisma connects to the throwaway test DB
// instead of the developer's real DATABASE_URL. Guarded: if TEST_DATABASE_URL
// is unset we leave DATABASE_URL alone and the suite skips itself.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// ── Shopify: cut the network at the knees ────────────────────────────────────
//
// This file used to override DATABASE_URL and NOTHING ELSE, which left the real
// SHOPIFY_* credentials loaded. An integration test that called
// startBatchProductImport(uploadId, ['store1', 'store2']) therefore reached the
// REAL test stores, submitted REAL bulk mutations, and created REAL products —
// while its author believed those stores were unconfigured and the calls would
// fail harmlessly. It did exactly that on 2026-07-14 (two junk products, since
// deleted by their per-run tag).
//
// Integration tests here exercise OUR persistence, reconcile and rollup logic.
// They have no business talking to Shopify. A test that genuinely needs Shopify
// behavior must inject a fake client. Never rely on "that store probably isn't
// configured" — that is not a safety boundary, it is a guess about someone
// else's .env.
//
// WHY WE PIN TO EMPTY RATHER THAN `delete`:
// deleting these keys does not work. `@prisma/client` loads .env when the client
// is constructed, which happens on the first `import prisma`, i.e. AFTER this
// setup file has run — and that repopulates SHOPIFY_TEST_STORES behind our back.
// dotenv does not overwrite a key that is already present, so assigning an empty
// value here survives every later load. Empty string / `[]` make
// getShopifyStoresConfig() resolve zero stores, so getShopifyClient() throws
// ShopifyConfigError instead of handing back a live, authenticated client.
//
// Opt out only with an explicit, loud env var, and only if you mean it:
//   ALLOW_REAL_SHOPIFY_IN_TESTS=1
if (process.env.ALLOW_REAL_SHOPIFY_IN_TESTS !== '1') {
  // The JSON multi-store form (what this repo actually uses).
  process.env.SHOPIFY_TEST_STORES = '[]';

  // The single-store form.
  for (const key of [
    'SHOPIFY_SHOP',
    'SHOPIFY_STORE_ID',
    'SHOPIFY_STORE_LABEL',
    'SHOPIFY_API_VERSION',
    'SHOPIFY_ADMIN_TOKEN',
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
  ]) {
    process.env[key] = '';
  }

  // The numbered form (config/shopify.ts fromNumberedEnv loops 1..20). A store is
  // skipped when SHOPIFY_SHOP_{n} is falsy, so emptying that one key per index is
  // enough to disable the whole slot.
  for (let i = 1; i <= 20; i++) {
    process.env[`SHOPIFY_SHOP_${i}`] = '';
  }
}
