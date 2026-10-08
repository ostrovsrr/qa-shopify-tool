import { getShopifyClient } from './shopifyClient';

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

/**
 * The product half of the entity-agnostic cleanup engine (cleanupRun.service.ts).
 * The twin of customerCleanupAdapter — everything cleanup does is identical across
 * the two flows except these four things.
 */
export const productCleanupAdapter = {
  entity: 'PRODUCT' as const,
  bulkThreshold: BULK_DELETE_THRESHOLD,
  fetchIdsByTag: fetchProductIdsByTag,
  serialDelete: async (
    client: Awaited<ReturnType<typeof getShopifyClient>>,
    ids: string[],
  ): Promise<{ deleted: number; errors: { id: string; message: string }[] }> => {
    const out = await serialDeleteProducts(client, ids);
    return {
      deleted: out.deleted,
      errors: out.errors.map((e) => ({ id: e.productId, message: e.message })),
    };
  },
  deleteSpec: {
    mutation: PRODUCT_DELETE_MUTATION,
    filename: 'bulk_product_delete.jsonl',
    payloadKey: 'productDelete',
    deletedIdKey: 'deletedProductId',
  },
};

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
