import { getShopifyClient } from './shopifyClient';
import {
  stagedUpload,
  runBulkMutation,
  fetchBulkOperationState,
  fetchAndParseBulkResults,
  TERMINAL_BULK_STATUSES,
} from './shopifyBulk';

const QA_IMPORT_TAG = 'qa-import';

// customerDelete as a bulk mutation string (validated against the 2026-01 schema;
// requires write_customers). One JSONL line per id supplies $input.
const CUSTOMER_DELETE_MUTATION =
  'mutation customerDelete($input: CustomerDeleteInput!) { customerDelete(input: $input) { deletedCustomerId userErrors { field message } } }';

// Below this many tagged customers, the serial per-id loop is faster than a bulk
// op (which pays a fixed staged-upload + poll-latency cost of a few seconds).
// Above it, one bulk operation wins decisively.
const BULK_DELETE_THRESHOLD = 50;

// Bulk-op poll cadence + cap. ~150 * 2s ≈ 5 min, well beyond a typical teardown;
// keeps the request synchronous (same blocking shape as the old serial loop).
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 150;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

// Bulk delete via a single bulkOperationRunMutation over a staged JSONL. Polls to
// completion synchronously (same blocking shape as the serial loop, far fewer calls)
// and parses per-line results back into the CleanupResult error list.
async function bulkDeleteCustomers(
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  ids: string[],
): Promise<DeleteOutcome> {
  const jsonl = ids.map((id) => JSON.stringify({ input: { id } })).join('\n');
  const stagedPath = await stagedUpload(client, jsonl, 'bulk_customer_delete.jsonl');
  const bulkOpId = await runBulkMutation(client, CUSTOMER_DELETE_MUTATION, stagedPath);

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

  const outcomes = await fetchAndParseBulkResults<string, { ok: boolean; customerId: string; message?: string }>(
    state.url,
    ids,
    ({ ref, data, raw }) => {
      const payload = data.customerDelete as
        | { deletedCustomerId: string | null; userErrors: { message: string }[] }
        | undefined;

      if (!payload) {
        // Top-level error line (e.g. malformed input) — no mutation payload.
        const message = typeof raw.message === 'string' ? raw.message : 'Unknown bulk delete error.';
        return { ok: false, customerId: ref ?? 'unknown', message };
      }
      if (payload.userErrors.length === 0 && payload.deletedCustomerId) {
        return { ok: true, customerId: ref ?? payload.deletedCustomerId };
      }
      const message =
        payload.userErrors.map((e) => e.message).join('; ') || 'Delete rejected by Shopify.';
      return { ok: false, customerId: ref ?? 'unknown', message };
    },
  );

  for (const o of outcomes) {
    if (o.ok) {
      deleted++;
    } else {
      errors.push({ customerId: o.customerId, message: o.message ?? 'Unknown delete failure.' });
    }
  }

  return { deleted, errors };
}

export function qaImportTagForRun(importRunId: string): string {
  return `${QA_IMPORT_TAG}-${importRunId}`;
}

export { QA_IMPORT_TAG };
