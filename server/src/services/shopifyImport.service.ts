import { v4 as uuidv4 } from 'uuid';
import prisma from '../db/prisma';
import { getShopifyClient, ShopifyClient } from './shopifyClient';

// Strict create so duplicates surface as TAKEN against the empty test store.
// userErrors here is plain UserError (no `code`) — we synthesize a stable code
// from the message tail so feedback can aggregate on (field, code), not message.
const CUSTOMER_CREATE_MUTATION =
  'mutation call($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }';

// Applied to every created customer so the whole import is reversible
// (batch-delete by tag during teardown).
const TEARDOWN_TAG = 'qa-import';

export interface ImportRowOutcome {
  rowNumber: number;
  accepted: boolean;
  shopifyCustomerId: string | null;
  shopifyField: string | null;
  shopifyCode: string | null;
  message: string | null;
}

export type RunImportResult =
  | { notFound: true }
  | { ok: false; error: string }
  | { ok: true; importRunId: string };

// ── value helpers ────────────────────────────────────────────────────────────

function mapRecord(
  original: Record<string, string>,
  mapping: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!mapping || Object.keys(mapping).length === 0) return { ...original };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(original)) {
    out[mapping[key] ?? key] = value;
  }
  return out;
}

function val(row: Record<string, string>, col: string): string {
  return (row[col] ?? '').trim();
}

function isTruthy(v: string): boolean {
  return ['true', 'yes', '1', 'y', 't'].includes(v.trim().toLowerCase());
}

// Drop undefined/empty entries so we don't send empty strings Shopify may reject.
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)) {
      out[k] = v;
    }
  }
  return out as Partial<T>;
}

/** Build a CustomerInput from one mapped (Shopify-column-keyed) row. */
function buildCustomerInput(
  mapped: Record<string, string>,
  importRunId: string,
): Record<string, unknown> {
  const csvTags = val(mapped, 'Tags')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const tags = [TEARDOWN_TAG, `qa-import-${importRunId}`, ...csvTags];

  const address = compact({
    address1: val(mapped, 'Default Address Address1'),
    address2: val(mapped, 'Default Address Address2'),
    city: val(mapped, 'Default Address City'),
    provinceCode: val(mapped, 'Default Address Province Code'),
    countryCode: val(mapped, 'Default Address Country Code').toUpperCase(),
    zip: val(mapped, 'Default Address Zip'),
    company: val(mapped, 'Default Address Company'),
    phone: val(mapped, 'Default Address Phone'),
  });

  const input: Record<string, unknown> = compact({
    firstName: val(mapped, 'First Name'),
    lastName: val(mapped, 'Last Name'),
    email: val(mapped, 'Email'),
    phone: val(mapped, 'Phone'),
    note: val(mapped, 'Note'),
    tags,
    // Marketing consent is intentionally omitted — the test-store guardrail is
    // "no marketing workflows", and consent requires enum + opt-in level.
  });

  if (mapped['Tax Exempt'] !== undefined && val(mapped, 'Tax Exempt') !== '') {
    input.taxExempt = isTruthy(val(mapped, 'Tax Exempt'));
  }
  if (Object.keys(address).length > 0) {
    input.addresses = [address];
  }
  return input;
}

interface OriginalRowRecord {
  rowNumber: number;
  data: unknown;
}

interface BuiltJsonl {
  jsonl: string;
  /** input line index (0-based) → CSV rowNumber */
  lineToRow: number[];
}

function buildJsonl(
  rows: OriginalRowRecord[],
  mapping: Record<string, string> | null | undefined,
  importRunId: string,
): BuiltJsonl {
  const lines: string[] = [];
  const lineToRow: number[] = [];
  for (const row of rows) {
    const original = (row.data ?? {}) as Record<string, string>;
    const mapped = mapRecord(original, mapping);
    const input = buildCustomerInput(mapped, importRunId);
    lines.push(JSON.stringify({ input }));
    lineToRow.push(row.rowNumber);
  }
  return { jsonl: lines.join('\n'), lineToRow };
}

// ── synthesized error code (no `code` on customerCreate userErrors) ──────────

function synthesizeCode(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('has already been taken')) return 'TAKEN';
  if (m.includes("can't be blank") || m.includes('cannot be blank')) return 'BLANK';
  if (m.includes('is required')) return 'BLANK';
  if (m.includes('is too long')) return 'TOO_LONG';
  if (m.includes('is too short')) return 'TOO_SHORT';
  if (m.includes('is invalid') || m.includes('not a valid')) return 'INVALID';
  return 'OTHER';
}

function lastFieldSegment(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  const segments = field.filter((s) => s !== 'input');
  const last = (segments[segments.length - 1] ?? field[field.length - 1]) as string;
  return typeof last === 'string' ? last : null;
}

// ── staged upload → run → poll ───────────────────────────────────────────────

interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
}

async function stagedUpload(
  client: ShopifyClient,
  jsonl: string,
): Promise<string> {
  const data = await client.query<{
    stagedUploadsCreate: {
      stagedTargets: StagedTarget[];
      userErrors: { field: string[]; message: string }[];
    };
  }>(
    `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          resource: 'BULK_MUTATION_VARIABLES',
          filename: 'bulk_customers.jsonl',
          mimeType: 'text/jsonl',
          httpMethod: 'POST',
        },
      ],
    },
  );

  const errs = data.stagedUploadsCreate.userErrors;
  if (errs.length > 0) {
    throw new Error(`stagedUploadsCreate failed: ${errs.map((e) => e.message).join('; ')}`);
  }
  const target = data.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error('stagedUploadsCreate returned no target.');

  // POST the file to the staged target (Google Cloud Storage). The provided
  // form parameters MUST be appended before the file field, and the file last.
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([jsonl], { type: 'text/jsonl' }), 'bulk_customers.jsonl');

  const uploadRes = await fetch(target.url, { method: 'POST', body: form });
  if (uploadRes.status >= 300) {
    const body = await uploadRes.text();
    throw new Error(`Staged upload POST failed (HTTP ${uploadRes.status}): ${body.slice(0, 300)}`);
  }

  // bulkOperationRunMutation wants the "key" parameter value as stagedUploadPath.
  const key = target.parameters.find((p) => p.name === 'key')?.value;
  if (!key) throw new Error('Staged upload response missing "key" parameter.');
  return key;
}

async function runBulkMutation(
  client: ShopifyClient,
  stagedUploadPath: string,
): Promise<string> {
  const data = await client.query<{
    bulkOperationRunMutation: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: { field: string[]; message: string; code: string | null }[];
    };
  }>(
    `mutation bulkRun($mutation: String!, $path: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {
        bulkOperation { id status }
        userErrors { field message code }
      }
    }`,
    { mutation: CUSTOMER_CREATE_MUTATION, path: stagedUploadPath },
  );

  const errs = data.bulkOperationRunMutation.userErrors;
  if (errs.length > 0) {
    const inProgress = errs.find((e) => /already in progress|in progress/i.test(e.message));
    if (inProgress) {
      throw new Error(
        'Another bulk operation is already running on this shop. Only one runs at a time — wait for it to finish and retry.',
      );
    }
    throw new Error(`bulkOperationRunMutation failed: ${errs.map((e) => e.message).join('; ')}`);
  }
  const op = data.bulkOperationRunMutation.bulkOperation;
  if (!op) throw new Error('bulkOperationRunMutation returned no operation.');
  return op.id;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface BulkOperationState {
  id: string;
  status: string;
  errorCode: string | null;
  objectCount: string | null;
  url: string | null;
  partialDataUrl: string | null;
}

async function pollBulkOperation(
  client: ShopifyClient,
  id: string,
  { maxAttempts = 1800, intervalMs = 5000 } = {},
): Promise<BulkOperationState> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const data = await client.query<{ node: BulkOperationState | null }>(
      `query pollBulk($id: ID!) {
        node(id: $id) {
          ... on BulkOperation { id status errorCode objectCount url partialDataUrl }
        }
      }`,
      { id },
    );
    const node = data.node;
    if (!node) throw new Error(`Bulk operation ${id} not found while polling.`);

    if (node.status === 'COMPLETED') return node;
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(node.status)) {
      throw new Error(
        `Bulk operation ${node.status}${node.errorCode ? ` (${node.errorCode})` : ''}.`,
      );
    }
    await sleep(intervalMs);
  }
  throw new Error(`Bulk operation timed out after ${maxAttempts} polls.`);
}

async function fetchAndParseResults(
  url: string,
  lineToRow: number[],
): Promise<ImportRowOutcome[]> {
  const res = await fetch(url);
  if (res.status >= 300) {
    throw new Error(`Failed to download bulk results (HTTP ${res.status}).`);
  }
  const text = await res.text();
  const parsed = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  if (parsed.length === 0) return [];

  // __lineNumber may be 0- or 1-based depending on context; detect from the
  // minimum so the row mapping is robust either way.
  const lineNumbers = parsed.map((p) => Number(p.__lineNumber));
  const base = Math.min(...lineNumbers);

  return parsed.map((line) => {
    const idx = Number(line.__lineNumber) - base;
    const rowNumber = lineToRow[idx] ?? -1;

    // Payload may be at line.data.customerCreate or line.customerCreate.
    const dataObj = (line.data ?? line) as Record<string, unknown>;
    const payload = dataObj.customerCreate as
      | {
          customer: { id: string } | null;
          userErrors: { field: unknown; message: string }[];
        }
      | undefined;

    if (!payload) {
      // Top-level error line (e.g. malformed variables) — treat as rejected.
      const message =
        typeof line.message === 'string' ? line.message : 'Unknown bulk error.';
      return {
        rowNumber,
        accepted: false,
        shopifyCustomerId: null,
        shopifyField: null,
        shopifyCode: synthesizeCode(message),
        message,
      };
    }

    if (payload.userErrors.length === 0 && payload.customer) {
      return {
        rowNumber,
        accepted: true,
        shopifyCustomerId: payload.customer.id,
        shopifyField: null,
        shopifyCode: null,
        message: null,
      };
    }

    const first = payload.userErrors[0];
    const message = first?.message ?? 'Rejected by Shopify.';
    return {
      rowNumber,
      accepted: false,
      shopifyCustomerId: payload.customer?.id ?? null,
      shopifyField: lastFieldSegment(first?.field),
      shopifyCode: synthesizeCode(message),
      message,
    };
  });
}

// ── orchestrator ─────────────────────────────────────────────────────────────

export async function runCustomerImport(
  validationId: string,
  storeId?: string,
): Promise<RunImportResult> {
  const run = await prisma.validationRun.findUnique({
    where: { id: validationId },
    include: {
      originalRows: { orderBy: { rowNumber: 'asc' } },
      issues: { select: { rowNumber: true } },
    },
  });
  if (!run) return { notFound: true };

  // Throws ShopifyConfigError (handled by controller) if env is unset.
  const client = await getShopifyClient(storeId);
  const health = await client.verifyConnection();
  if (!health.ok) {
    return { ok: false, error: health.error ?? 'Shopify connection not healthy.' };
  }

  const importRunId = uuidv4();
  const { jsonl, lineToRow } = buildJsonl(
    run.originalRows,
    run.columnMapping as Record<string, string> | null,
    importRunId,
  );

  if (lineToRow.length === 0) {
    return { ok: false, error: 'This validation run has no rows to import.' };
  }

  const stagedPath = await stagedUpload(client, jsonl);
  const bulkOpId = await runBulkMutation(client, stagedPath);
  const finalState = await pollBulkOperation(client, bulkOpId);
  const outcomes = finalState.url
    ? await fetchAndParseResults(finalState.url, lineToRow)
    : [];

  const flaggedRows = new Set(run.issues.map((i) => i.rowNumber));
  const successCount = outcomes.filter((o) => o.accepted).length;
  const errorCount = outcomes.length - successCount;

  await prisma.importRun.create({
    data: {
      id: importRunId,
      validationId,
      shopDomain: health.shop ?? '',
      bulkOperationId: bulkOpId,
      status: finalState.status,
      successCount,
      errorCount,
      rowResults: {
        create: outcomes.map((o) => ({
          id: uuidv4(),
          rowNumber: o.rowNumber,
          accepted: o.accepted,
          shopifyCustomerId: o.shopifyCustomerId,
          shopifyCode: o.shopifyCode,
          shopifyField: o.shopifyField,
          message: o.message,
          wasFlaggedByValidator: flaggedRows.has(o.rowNumber),
        })),
      },
    },
  });

  return { ok: true, importRunId };
}
