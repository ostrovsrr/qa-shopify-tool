import { z } from 'zod';

const DEFAULT_API_VERSION = '2026-01';

const apiVersionSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'SHOPIFY_API_VERSION must look like "2026-01".')
  .default(DEFAULT_API_VERSION);

const SHOP_REQUIRED = 'Shop domain is required (e.g. my-store.myshopify.com)';

// A whitespace-only shop used to pass min(1) and then normalise to "" — a store with
// no domain and an empty id.
const shopSchema = z
  .string()
  .refine((value) => value.trim().length > 0, SHOP_REQUIRED);

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

// The forms people actually paste, all meaning the same shop:
//   my-store.myshopify.com
//   https://my-store.myshopify.com/
//   my-store.myshopify.com/admin            (copied from the old admin URL)
//   https://admin.shopify.com/store/my-store/products   (the new admin URL)
// Every one must normalise to "my-store.myshopify.com", or the same shop gets two
// different lock keys and two operations can run against it at once.
//
// Ids are derived from this for stores configured without one, so the result for a
// form that already worked (a bare or https:// domain, trailing slash) is unchanged.
const ADMIN_STORE_URL_RE = /^(?:https?:\/\/)?admin\.shopify\.com\/store\/([^/?#]+)/i;

export function normalizeShop(raw: string): string {
  const trimmed = raw.trim();
  const admin = ADMIN_STORE_URL_RE.exec(trimmed);
  if (admin) return `${admin[1]}.myshopify.com`;
  return trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '');
}

function normalizeId(raw: string): string {
  return normalizeShop(raw)
    .toLowerCase()
    .replace(/\.myshopify\.com$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Config errors reach the browser ─────────────────────────────────────────
//
// The message of anything thrown here is cached as the config error and returned
// to the UI (GET /api/shopify/stores, ShopifyConfigError passthrough). So it must
// never contain the configured VALUES — those include the shared client secret and
// admin tokens. In particular:
//   - JSON.parse's SyntaxError quotes a slice of the input in V8
//     ("...\"clientSecret\":abc12..." is not valid JSON), so it is caught and
//     replaced by a fixed message;
//   - a ZodError's own message is a JSON dump of its issues; we use only each
//     issue's path and message, and every message reachable here is either a
//     fixed string from this file or a zod default that describes the expectation,
//     never the received value.
function describeIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

function validateStore(store: ShopifyStoreConfig): ShopifyStoreConfig {
  if (!store.shop) {
    throw new Error(`${store.label}: ${SHOP_REQUIRED}`);
  }
  if (!store.id) {
    throw new Error(`${store.label} (${store.shop}) has an empty store id.`);
  }
  if (!store.adminToken && (!store.clientId || !store.clientSecret)) {
    throw new Error(
      `${store.label} (${store.shop}) needs either adminToken or clientId + clientSecret.`,
    );
  }
  if (store.adminToken) {
    const token = tokenSchema.safeParse(store.adminToken);
    if (!token.success) {
      throw new Error(`${store.label} (${store.shop}): ${token.error.errors[0].message}`);
    }
  }
  const version = apiVersionSchema.safeParse(store.apiVersion);
  if (!version.success) {
    throw new Error(`${store.label} (${store.shop}): ${version.error.errors[0].message}`);
  }
  return store;
}

function fromJsonEnv(): ShopifyStoreConfig[] {
  const raw = process.env.SHOPIFY_TEST_STORES;
  if (!raw) return [];

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Deliberately NOT the SyntaxError's message: it quotes the input.
    throw new Error(
      'SHOPIFY_TEST_STORES is not valid JSON. Check its syntax (quotes, commas, brackets); the value is not shown because it contains credentials.',
    );
  }

  const parsed = z.array(jsonStoreSchema).safeParse(json);
  if (!parsed.success) {
    throw new Error(`SHOPIFY_TEST_STORES is invalid: ${describeIssue(parsed.error.errors[0])}`);
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
    // The store lock is keyed by id. One shop listed under two ids would get two
    // lock keys, so two operations could run against the same shop at once.
    const shopOwner = new Map<string, string>();
    for (const store of effectiveStores) {
      if (seen.has(store.id)) {
        throw new Error(`Duplicate Shopify store id "${store.id}".`);
      }
      seen.add(store.id);
      const shopKey = store.shop.toLowerCase();
      const owner = shopOwner.get(shopKey);
      if (owner !== undefined) {
        throw new Error(
          `Shopify shop "${store.shop}" is configured twice (store ids "${owner}" and "${store.id}"). List each shop once.`,
        );
      }
      shopOwner.set(shopKey, store.id);
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

/**
 * Should THIS instance's background sweeps touch a row for this store?
 *
 * One instance per Solution Engineer against a SHARED database, so every sweep sees
 * every colleague's rows too. Reconciling one we have no token for cannot corrupt
 * anything — reconcile throws and the sweep logs it — but it means eight instances
 * logging a failure a minute for every run the ninth owns, which buries the
 * failures that matter. (Observed: one colleague's cleanup filled every other
 * instance's log, and so the status page, with "store is not configured".)
 *
 * Judged only when there IS a config to judge against: with no usable store list,
 * resolveStoreId returns null for everything alike, and skipping on that basis would
 * turn a misconfiguration into a silent no-op. Then it is better to attempt and fail
 * loudly. Same reasoning as importResume.service.ts.
 */
export function sweepOwnsStore(storeId: string | null): boolean {
  const config = getShopifyStoresConfig();
  if (!config.ok || config.stores.length === 0) return true;
  if (!storeId) return true; // legacy single-store row — let the normal path speak
  return Boolean(resolveStoreId(storeId));
}

export function resetShopifyConfigCache(): void {
  cached = null;
}

/** Shopify allows 5 concurrent bulk mutations per app per shop from API 2026-01. */
export const MAX_BULK_OPS_PER_SHOP = 5;

/**
 * How many bulk operations one store's import / cleanup is split across.
 * `BULK_OPS_PER_STORE=1` is the kill switch: one bulk op per store (still the batch path).
 * Unset or non-numeric means the Shopify cap; anything else is clamped to 1..cap.
 */
export function getBulkOpsPerStore(): number {
  const raw = process.env.BULK_OPS_PER_STORE?.trim();
  if (!raw) return MAX_BULK_OPS_PER_SHOP;
  const n = Number(raw);
  if (!Number.isFinite(n)) return MAX_BULK_OPS_PER_SHOP;
  return Math.max(1, Math.min(MAX_BULK_OPS_PER_SHOP, Math.trunc(n)));
}
