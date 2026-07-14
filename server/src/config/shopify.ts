import { z } from 'zod';

const DEFAULT_API_VERSION = '2026-01';

const apiVersionSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'SHOPIFY_API_VERSION must look like "2026-01".')
  .default(DEFAULT_API_VERSION);

const shopSchema = z
  .string()
  .min(1, 'Shop domain is required (e.g. my-store.myshopify.com)');

const tokenSchema = z
  .string()
  .regex(
    /^shp(at|ca)_/,
    'Shopify Admin API access token must start with "shpat_" or "shpca_".',
  );

export interface ShopifyStoreConfig {
  id: string;
  label: string;
  shop: string;
  apiVersion: string;
  adminToken?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface SafeShopifyStore {
  id: string;
  label: string;
  shop: string;
  apiVersion: string;
  authMode: 'adminToken' | 'clientCredentials';
}

export type ShopifyStoreConfigResult =
  | { ok: true; stores: ShopifyStoreConfig[] }
  | { ok: false; error: string };

export type ShopifyConfigResult =
  | { ok: true; config: ShopifyStoreConfig }
  | { ok: false; error: string };

const jsonStoreSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  shop: shopSchema,
  apiVersion: apiVersionSchema.optional(),
  adminToken: tokenSchema.optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
});

function normalizeShop(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

function normalizeId(raw: string): string {
  return normalizeShop(raw)
    .toLowerCase()
    .replace(/\.myshopify\.com$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validateStore(store: ShopifyStoreConfig): ShopifyStoreConfig {
  if (!store.adminToken && (!store.clientId || !store.clientSecret)) {
    throw new Error(
      `${store.label} (${store.shop}) needs either adminToken or clientId + clientSecret.`,
    );
  }
  if (store.adminToken) tokenSchema.parse(store.adminToken);
  apiVersionSchema.parse(store.apiVersion);
  return store;
}

function fromJsonEnv(): ShopifyStoreConfig[] {
  const raw = process.env.SHOPIFY_TEST_STORES;
  if (!raw) return [];

  const parsed = z.array(jsonStoreSchema).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`SHOPIFY_TEST_STORES is invalid: ${parsed.error.errors[0].message}`);
  }

  return parsed.data.map((store, index) =>
    validateStore({
      id: store.id ?? normalizeId(store.shop),
      label: store.label ?? `Test Store ${index + 1}`,
      shop: normalizeShop(store.shop),
      apiVersion: store.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? DEFAULT_API_VERSION,
      adminToken: store.adminToken,
      clientId: store.clientId,
      clientSecret: store.clientSecret,
    }),
  );
}

function fromNumberedEnv(): ShopifyStoreConfig[] {
  const stores: ShopifyStoreConfig[] = [];

  for (let index = 1; index <= 20; index++) {
    const shop = process.env[`SHOPIFY_SHOP_${index}`];
    if (!shop) continue;

    stores.push(
      validateStore({
        id: process.env[`SHOPIFY_STORE_ID_${index}`] ?? normalizeId(shop),
        label: process.env[`SHOPIFY_STORE_LABEL_${index}`] ?? `Test Store ${index}`,
        shop: normalizeShop(shop),
        apiVersion:
          process.env[`SHOPIFY_API_VERSION_${index}`] ??
          process.env.SHOPIFY_API_VERSION ??
          DEFAULT_API_VERSION,
        adminToken: process.env[`SHOPIFY_ADMIN_TOKEN_${index}`],
        clientId: process.env[`SHOPIFY_CLIENT_ID_${index}`],
        clientSecret: process.env[`SHOPIFY_CLIENT_SECRET_${index}`],
      }),
    );
  }

  return stores;
}

function fromLegacyEnv(): ShopifyStoreConfig[] {
  if (!process.env.SHOPIFY_SHOP) return [];

  return [
    validateStore({
      id: process.env.SHOPIFY_STORE_ID ?? normalizeId(process.env.SHOPIFY_SHOP),
      label: process.env.SHOPIFY_STORE_LABEL ?? 'Default Test Store',
      shop: normalizeShop(process.env.SHOPIFY_SHOP),
      apiVersion: process.env.SHOPIFY_API_VERSION ?? DEFAULT_API_VERSION,
      adminToken: process.env.SHOPIFY_ADMIN_TOKEN,
      clientId: process.env.SHOPIFY_CLIENT_ID,
      clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  ];
}

let cached: ShopifyStoreConfigResult | null = null;

export function getShopifyStoresConfig(): ShopifyStoreConfigResult {
  if (cached) return cached;

  try {
    const stores = [...fromJsonEnv(), ...fromNumberedEnv()];
    const effectiveStores = stores.length > 0 ? stores : fromLegacyEnv();

    if (effectiveStores.length === 0) {
      cached = {
        ok: false,
        error:
          'No Shopify test stores configured. Set SHOPIFY_TEST_STORES, SHOPIFY_SHOP_1, or legacy SHOPIFY_SHOP.',
      };
      return cached;
    }

    const seen = new Set<string>();
    for (const store of effectiveStores) {
      if (seen.has(store.id)) {
        throw new Error(`Duplicate Shopify store id "${store.id}".`);
      }
      seen.add(store.id);
    }

    cached = { ok: true, stores: effectiveStores };
    return cached;
  } catch (err) {
    cached = { ok: false, error: (err as Error).message };
    return cached;
  }
}

export function getSafeShopifyStores(): SafeShopifyStore[] {
  const result = getShopifyStoresConfig();
  if (!result.ok) return [];

  return result.stores.map((store) => ({
    id: store.id,
    label: store.label,
    shop: store.shop,
    apiVersion: store.apiVersion,
    authMode: store.adminToken ? 'adminToken' : 'clientCredentials',
  }));
}

export function getShopifyConfig(storeId?: string): ShopifyConfigResult {
  const result = getShopifyStoresConfig();
  if (!result.ok) return result;

  // NO SILENT DEFAULT. This used to fall back to stores[0] when storeId was absent,
  // which meant "I forgot to say which store" and "I meant the first store" were
  // indistinguishable — and the answer arrived as REAL RECORDS IN A REAL STORE.
  //
  // With one user that was merely sloppy. With a shared store pool it is a way to
  // write a merchant's customers into whichever store happens to be listed first,
  // possibly the one a colleague is mid-QA on. It also made the busy-lock ambiguous:
  // a request naming store1 and a request naming nothing hit the same shop and had
  // to be resolved to the same lock key before they could contend properly.
  //
  // An unspecified store is now an error, not a guess.
  if (!storeId) {
    return { ok: false, error: 'No Shopify store selected. Choose a store and try again.' };
  }

  const config = result.stores.find((store) => store.id === storeId);

  if (!config) {
    return { ok: false, error: `Shopify test store "${storeId}" is not configured.` };
  }

  return { ok: true, config };
}

/**
 * The store id an operation will hit, or null if it names no configured store.
 *
 * Now that the silent stores[0] fallback is gone this is close to an identity
 * function, and that is the point: there is exactly one store id, the one the
 * caller named. It survives because the resume path reads storeId off a DB row,
 * where legacy rows written before the fallback was removed can still hold NULL —
 * those have no store to lock, and must not be guessed at.
 */
export function resolveStoreId(storeId?: string): string | null {
  const result = getShopifyConfig(storeId);
  return result.ok ? result.config.id : null;
}

export function resetShopifyConfigCache(): void {
  cached = null;
}
