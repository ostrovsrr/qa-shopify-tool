import { z } from 'zod';

const schema = z.object({
  SHOPIFY_SHOP: z
    .string()
    .min(1, 'SHOPIFY_SHOP is required (e.g. my-store.myshopify.com)'),
  SHOPIFY_ADMIN_TOKEN: z
    .string()
    .regex(
      /^shp(at|ca)_/,
      'SHOPIFY_ADMIN_TOKEN must be an Admin API access token (starts with "shpat_" or "shpca_").',
    ),
  SHOPIFY_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'SHOPIFY_API_VERSION must look like "2026-01".')
    .default('2026-01'),
});

export interface ShopifyConfig {
  shop: string;
  adminToken: string;
  apiVersion: string;
}

export type ShopifyConfigResult =
  | { ok: true; config: ShopifyConfig }
  | { ok: false; error: string };

// Normalize "https://store.myshopify.com/" → "store.myshopify.com"
function normalizeShop(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

let cached: ShopifyConfigResult | null = null;

/**
 * Loads + validates Shopify config from the environment. Never throws — a
 * missing/invalid config is surfaced as { ok: false } so the server still
 * boots and the /api/shopify/health endpoint can report the problem.
 */
export function getShopifyConfig(): ShopifyConfigResult {
  if (cached) return cached;

  const parsed = schema.safeParse({
    SHOPIFY_SHOP: process.env.SHOPIFY_SHOP,
    SHOPIFY_ADMIN_TOKEN: process.env.SHOPIFY_ADMIN_TOKEN,
    SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION,
  });

  if (!parsed.success) {
    cached = { ok: false, error: parsed.error.errors[0].message };
    return cached;
  }

  cached = {
    ok: true,
    config: {
      shop: normalizeShop(parsed.data.SHOPIFY_SHOP),
      adminToken: parsed.data.SHOPIFY_ADMIN_TOKEN,
      apiVersion: parsed.data.SHOPIFY_API_VERSION,
    },
  };
  return cached;
}

// Test/maintenance helper — drop the memoized result (e.g. after env changes).
export function resetShopifyConfigCache(): void {
  cached = null;
}
