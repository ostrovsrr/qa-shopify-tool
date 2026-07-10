import { getShopifyClient } from './shopifyClient';
import {
  fetchAndParseBulkResults,
  fetchBulkOperationState,
  runBulkMutation,
  stagedUpload,
  TERMINAL_BULK_STATUSES,
} from './shopifyBulk';

// The base teardown tag applied to every QA-imported product (alongside the
// per-run qa-import-<importRunId> tag). Cleanup deletes by tag so an import is
// fully reversible. Kept here (not imported from productImport.service) to avoid a
// cleanup ↔ import cycle; it mirrors that service's TEARDOWN_TAG.
export const QA_IMPORT_TAG = 'qa-import';

// productDelete as a bulk mutation string (validated against the 2026-04 schema;
// requires write_products). One JSONL line per id supplies $input.
const PRODUCT_DELETE_MUTATION =
  'mutation productDelete($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }';

// Below this many tagged products, the serial per-id loop is faster than a bulk
// op (which pays a fixed staged-upload + poll-latency cost of a few seconds).
// Above it, one bulk operation wins decisively.
const BULK_DELETE_THRESHOLD = 50;

// Bulk-op poll cadence + cap. ~150 * 2s ≈ 5 min, well beyond a typical teardown;
// keeps the request synchronous (same blocking shape as the serial loop).
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 150;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ProductNode {
  id: string;
}

interface ProductPage {
  products: {
    nodes: ProductNode[];
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

interface DeletePayload {
  productDelete: {
    deletedProductId: string | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

export interface StoreProductStats {
  storeId: string | undefined;
  shop: string;
  totalProducts: number;
  qaImportProducts: number;
}

export interface CleanupResult {
  storeId: string | undefined;
  shop: string;
  tag: string;
  found: number;
  deleted: number;
  failed: number;
  errors: { productId: string; message: string }[];
}

// Escape the tag for the Shopify search query DSL (single-quoted literal).
function tagQuery(tag: string): string {
  const safeTag = tag.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `tag:'${safeTag}'`;
}

async function fetchProductIdsByTag(
  storeId: string | undefined,
  tag: string,
): Promise<{ shop: string; ids: string[] }> {
  const client = await getShopifyClient(storeId);
  const ids: string[] = [];
  let cursor: string | null = null;

  do {
    const data: ProductPage = await client.query<ProductPage>(
      `query taggedProducts($query: String!, $after: String) {
        products(first: 250, after: $after, query: $query) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { query: tagQuery(tag), after: cursor },
    );

    ids.push(...data.products.nodes.map((node: ProductNode) => node.id));
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  return { shop: client.shop, ids };
}

export async function getStoreProductStats(
  storeId?: string,
): Promise<StoreProductStats> {
  const client = await getShopifyClient(storeId);
  const data = await client.query<{
    all: { count: number };
    tagged: { count: number };
  }>(
    `query productCounts($query: String) {
      all: productsCount { count }
      tagged: productsCount(query: $query) { count }
    }`,
    { query: tagQuery(QA_IMPORT_TAG) },
  );

  return {
    storeId,
    shop: client.shop,
    totalProducts: data.all.count,
    qaImportProducts: data.tagged.count,
  };
}

export async function cleanupProductsByTag(
  storeId: string | undefined,
  tag: string,
): Promise<CleanupResult> {
  const { shop, ids } = await fetchProductIdsByTag(storeId, tag);

  if (ids.length === 0) {
    return { storeId, shop, tag, found: 0, deleted: 0, failed: 0, errors: [] };
  }

  const client = await getShopifyClient(storeId);
  const { deleted, errors } =
    ids.length <= BULK_DELETE_THRESHOLD
      ? await serialDeleteProducts(client, ids)
      : await bulkDeleteProducts(client, ids);

  return {
    storeId,
    shop,
    tag,
    found: ids.length,
    deleted,
    failed: errors.length,
    errors,
  };
}

interface DeleteOutcome {
  deleted: number;
  errors: CleanupResult['errors'];
}

// Serial per-id delete — for small teardowns where bulk staging overhead doesn't
// pay off. Reuses one client instead of re-fetching it each iteration.
async function serialDeleteProducts(
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  ids: string[],
): Promise<DeleteOutcome> {
  const errors: CleanupResult['errors'] = [];
  let deleted = 0;

  for (const productId of ids) {
    const data = await client.query<DeletePayload>(
      `mutation deleteProduct($id: ID!) {
        productDelete(input: { id: $id }) {
          deletedProductId
          userErrors { field message }
        }
      }`,
      { id: productId },
    );

    const userErrors = data.productDelete.userErrors;
    if (userErrors.length > 0 || !data.productDelete.deletedProductId) {
      errors.push({
        productId,
        message: userErrors.map((err) => err.message).join('; ') || 'Unknown delete failure.',
      });
      continue;
    }

    deleted++;
  }

  return { deleted, errors };
}

// Bulk delete via a single bulkOperationRunMutation over a staged JSONL. Polls to
// completion (same blocking shape as the serial loop, far fewer calls) and parses
// per-line results back into the CleanupResult error list.
async function bulkDeleteProducts(
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  ids: string[],
): Promise<DeleteOutcome> {
  const jsonl = ids.map((id) => JSON.stringify({ input: { id } })).join('\n');
  const stagedPath = await stagedUpload(client, jsonl, 'bulk_product_delete.jsonl');
  const bulkOpId = await runBulkMutation(client, PRODUCT_DELETE_MUTATION, stagedPath);

  let state = await fetchBulkOperationState(client, bulkOpId);
  for (
    let attempt = 0;
    !TERMINAL_BULK_STATUSES.includes(state.status) && attempt < MAX_POLL_ATTEMPTS;
    attempt++
  ) {
    await sleep(POLL_INTERVAL_MS);
    state = await fetchBulkOperationState(client, bulkOpId);
  }

  if (!TERMINAL_BULK_STATUSES.includes(state.status)) {
    throw new Error(
      `Bulk delete did not finish within ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s; ` +
        'it may still be running on Shopify — re-run cleanup shortly.',
    );
  }
  if (state.status !== 'COMPLETED') {
    throw new Error(
      `Bulk delete ${state.status}${state.errorCode ? ` (${state.errorCode})` : ''}.`,
    );
  }
  if (!state.url) {
    throw new Error('Bulk delete completed but Shopify returned no result file.');
  }

  const errors: CleanupResult['errors'] = [];
  let deleted = 0;

  const outcomes = await fetchAndParseBulkResults<
    string,
    { ok: boolean; productId: string; message?: string }
  >(state.url, ids, ({ ref, data, raw }) => {
    const payload = data.productDelete as
      | { deletedProductId: string | null; userErrors: { message: string }[] }
      | undefined;

    if (!payload) {
      // Top-level error line (e.g. malformed input) — no mutation payload.
      const message = typeof raw.message === 'string' ? raw.message : 'Unknown bulk delete error.';
      return { ok: false, productId: ref ?? 'unknown', message };
    }
    if (payload.userErrors.length === 0 && payload.deletedProductId) {
      return { ok: true, productId: ref ?? payload.deletedProductId };
    }
    const message =
      payload.userErrors.map((e) => e.message).join('; ') || 'Delete rejected by Shopify.';
    return { ok: false, productId: ref ?? 'unknown', message };
  });

  for (const o of outcomes) {
    if (o.ok) {
      deleted++;
    } else {
      errors.push({ productId: o.productId, message: o.message ?? 'Unknown delete failure.' });
    }
  }

  return { deleted, errors };
}
