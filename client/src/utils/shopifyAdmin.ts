/**
 * Deep links into the Shopify admin for a test store.
 *
 * `store.shop` comes off the server as a bare domain ("rodionteststore3.myshopify.com");
 * the admin URL wants just the store handle: admin.shopify.com/store/<handle>/products.
 */
export type AdminSection = 'products' | 'customers';

export function storeHandle(shop: string | undefined | null): string {
  return (shop ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/\.myshopify\.com$/i, '');
}

/** Null when we don't know the shop domain — render nothing rather than a broken link. */
export function shopifyAdminUrl(
  shop: string | undefined | null,
  section: AdminSection,
): string | null {
  const handle = storeHandle(shop);
  if (!handle) return null;
  return `https://admin.shopify.com/store/${encodeURIComponent(handle)}/${section}`;
}
