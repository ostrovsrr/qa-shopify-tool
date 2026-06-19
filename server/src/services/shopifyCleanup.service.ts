import { getShopifyClient } from './shopifyClient';

const QA_IMPORT_TAG = 'qa-import';

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
  const errors: CleanupResult['errors'] = [];
  let deleted = 0;

  for (const customerId of ids) {
    const client = await getShopifyClient(storeId);
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

export function qaImportTagForRun(importRunId: string): string {
  return `${QA_IMPORT_TAG}-${importRunId}`;
}

export { QA_IMPORT_TAG };
