import { getShopifyClient } from './shopifyClient';
import { bulkDeleteByIds } from './shopifyBulk';

const QA_IMPORT_TAG = 'qa-import';

// customerDelete as a bulk mutation string (validated against the 2026-01 schema;
// requires write_customers). One JSONL line per id supplies $input.
const CUSTOMER_DELETE_MUTATION =
  'mutation customerDelete($input: CustomerDeleteInput!) { customerDelete(input: $input) { deletedCustomerId userErrors { field message } } }';

// Below this many tagged customers, the serial per-id loop is faster than a bulk
// op (which pays a fixed staged-upload + poll-latency cost of a few seconds).
// Above it, one bulk operation wins decisively.
const BULK_DELETE_THRESHOLD = 50;

interface CustomerNode {
  id: string;
}

interface CustomerPage {
  customers: {
    nodes: CustomerNode[];
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

interface DeletePayload {
  customerDelete: {
    deletedCustomerId: string | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

export interface StoreCustomerStats {
  storeId: string | undefined;
  shop: string;
  totalCustomers: number;
  qaImportCustomers: number;
}

export interface CleanupResult {
  storeId: string | undefined;
  shop: string;
  tag: string;
  found: number;
  deleted: number;
  failed: number;
  errors: { customerId: string; message: string }[];
}

function tagQuery(tag: string): string {
  const safeTag = tag.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `tag:'${safeTag}'`;
}

async function fetchCustomerIdsByTag(
  storeId: string | undefined,
  tag: string,
): Promise<{ shop: string; ids: string[] }> {
  const client = await getShopifyClient(storeId);
  const ids: string[] = [];
  let cursor: string | null = null;

  do {
    const data: CustomerPage = await client.query<CustomerPage>(
      `query taggedCustomers($query: String!, $after: String) {
        customers(first: 250, after: $after, query: $query) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { query: tagQuery(tag), after: cursor },
    );

    ids.push(...data.customers.nodes.map((node: CustomerNode) => node.id));
    cursor = data.customers.pageInfo.hasNextPage
      ? data.customers.pageInfo.endCursor
      : null;
  } while (cursor);

  return { shop: client.shop, ids };
}

export async function getStoreCustomerStats(
  storeId?: string,
): Promise<StoreCustomerStats> {
  const client = await getShopifyClient(storeId);
  // The qa count MUST be derived the same way cleanup finds rows (the tag-aware
  // `customers` connection): customersCount's `query` only supports created_at/id/
  // updated_at and silently IGNORES a `tag:` term, so it would return the total and
  // make the count disagree with what "Clean QA" actually deletes. Total has no tag
  // filter, so the single customersCount is correct (and fast) for it.
  const [totalData, qaData] = await Promise.all([
    client.query<{ customersCount: { count: number } }>(
      `query customerCount {
        customersCount(limit: null) { count }
      }`,
    ),
    fetchCustomerIdsByTag(storeId, QA_IMPORT_TAG),
  ]);

  return {
    storeId,
    shop: client.shop,
    totalCustomers: totalData.customersCount.count,
    qaImportCustomers: qaData.ids.length,
  };
}

export async function cleanupCustomersByTag(
  storeId: string | undefined,
  tag: string,
): Promise<CleanupResult> {
  const { shop, ids } = await fetchCustomerIdsByTag(storeId, tag);

  if (ids.length === 0) {
    return { storeId, shop, tag, found: 0, deleted: 0, failed: 0, errors: [] };
  }

  const client = await getShopifyClient(storeId);
  const { deleted, errors } =
    ids.length <= BULK_DELETE_THRESHOLD
      ? await serialDeleteCustomers(client, ids)
      : await bulkDeleteCustomers(client, ids);

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

/**
 * The customer half of the entity-agnostic cleanup engine (cleanupRun.service.ts).
 * Everything cleanup does is identical across customers and products except these
 * four things, so this is all the engine needs to run a customer teardown.
 */
export const customerCleanupAdapter = {
  entity: 'CUSTOMER' as const,
  bulkThreshold: BULK_DELETE_THRESHOLD,
  fetchIdsByTag: fetchCustomerIdsByTag,
  serialDelete: async (
    client: Awaited<ReturnType<typeof getShopifyClient>>,
    ids: string[],
  ): Promise<{ deleted: number; errors: { id: string; message: string }[] }> => {
    const out = await serialDeleteCustomers(client, ids);
    return {
      deleted: out.deleted,
      errors: out.errors.map((e) => ({ id: e.customerId, message: e.message })),
    };
  },
  deleteSpec: {
    mutation: CUSTOMER_DELETE_MUTATION,
    filename: 'bulk_customer_delete.jsonl',
    payloadKey: 'customerDelete',
    deletedIdKey: 'deletedCustomerId',
  },
};

interface DeleteOutcome {
  deleted: number;
  errors: CleanupResult['errors'];
}

// Serial per-id delete — for small teardowns where bulk staging overhead doesn't
// pay off. Reuses one client instead of re-fetching it each iteration.
async function serialDeleteCustomers(
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  ids: string[],
): Promise<DeleteOutcome> {
  const errors: CleanupResult['errors'] = [];
  let deleted = 0;

  for (const customerId of ids) {
    const data = await client.query<DeletePayload>(
      `mutation deleteCustomer($id: ID!) {
        customerDelete(input: { id: $id }) {
          deletedCustomerId
          userErrors { field message }
        }
      }`,
      { id: customerId },
    );

    const userErrors = data.customerDelete.userErrors;
    if (userErrors.length > 0 || !data.customerDelete.deletedCustomerId) {
      errors.push({
        customerId,
        message: userErrors.map((err) => err.message).join('; ') || 'Unknown delete failure.',
      });
      continue;
    }

    deleted++;
  }

  return { deleted, errors };
}

// Bulk delete via a single bulkOperationRunMutation over a staged JSONL. The
// staging / polling / result-folding is the entity-agnostic engine (shopifyBulk);
// only the mutation and its payload key names are customer-specific.
async function bulkDeleteCustomers(
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  ids: string[],
): Promise<DeleteOutcome> {
  const { deleted, errors } = await bulkDeleteByIds(client, ids, {
    mutation: CUSTOMER_DELETE_MUTATION,
    filename: 'bulk_customer_delete.jsonl',
    payloadKey: 'customerDelete',
    deletedIdKey: 'deletedCustomerId',
  });

  return {
    deleted,
    errors: errors.map((e) => ({ customerId: e.id, message: e.message })),
  };
}

export function qaImportTagForRun(importRunId: string): string {
  return `${QA_IMPORT_TAG}-${importRunId}`;
}

export { QA_IMPORT_TAG };
