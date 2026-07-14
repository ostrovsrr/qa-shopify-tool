import type { ShopifyClient } from './shopifyClient';

// Generic, entity-agnostic Shopify bulk-operation engine. It knows the Shopify
// bulk protocol (staged upload → run mutation → poll → download/parse JSONL) but
// NOTHING about customers: callers inject the mutation string, build their own
// JSONL, and parse each result line into their own outcome shape.
//
// shopifyCleanup.service.ts uses this for bulk delete-by-tag, and
// shopifyImport.service.ts uses it for bulk customerCreate (injecting the
// CUSTOMER_CREATE_MUTATION and its own line parser). It depends only on
// shopifyClient, so it stays a leaf — importing it never risks a cycle.

// ── shared constants ─────────────────────────────────────────────────────────

// Shopify bulk-op statuses that mean the operation has stopped advancing.
export const TERMINAL_BULK_STATUSES = ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'];

// A batch job is failed once the reconcile poll has checked it this many times
// while still non-terminal — bounds a stuck job (perma-RUNNING or repeatedly
// erroring). At the client's ~3s poll cadence this is ~15 minutes of watching.
export const MAX_JOB_POLL_ATTEMPTS = 300;

// ── staged upload → run → poll ───────────────────────────────────────────────

interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
}

/** Stage a JSONL variables file for a bulk mutation and return its stagedUploadPath
 *  (the "key" parameter) for bulkOperationRunMutation. */
export async function stagedUpload(
  client: ShopifyClient,
  jsonl: string,
  filename = 'bulk.jsonl',
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
          filename,
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
  form.append('file', new Blob([jsonl], { type: 'text/jsonl' }), filename);

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

/** Kick off a bulk operation running `mutation` over the staged variables file.
 *  Returns the bulk operation id. The mutation string is caller-supplied so the
 *  engine stays entity-agnostic. */
export async function runBulkMutation(
  client: ShopifyClient,
  mutation: string,
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
    { mutation, path: stagedUploadPath },
  );

  const errs = data.bulkOperationRunMutation.userErrors;
  if (errs.length > 0) {
    const inProgress = errs.find((e) => /already in progress|in progress/i.test(e.message));
    if (inProgress) {
      throw new Error(
        'Too many bulk operations are already running on this shop (the per-shop concurrent limit is reached). Wait for one to finish and retry.',
      );
    }
    throw new Error(`bulkOperationRunMutation failed: ${errs.map((e) => e.message).join('; ')}`);
  }
  const op = data.bulkOperationRunMutation.bulkOperation;
  if (!op) throw new Error('bulkOperationRunMutation returned no operation.');
  return op.id;
}

export interface BulkOperationState {
  id: string;
  status: string;
  errorCode: string | null;
  objectCount: string | null;
  url: string | null;
  partialDataUrl: string | null;
}

// Single-shot poll: the async model advances one step per reconcile call instead
// of blocking an HTTP request in a multi-minute loop.
export async function fetchBulkOperationState(
  client: ShopifyClient,
  id: string,
): Promise<BulkOperationState> {
  const data = await client.query<{ node: BulkOperationState | null }>(
    `query pollBulk($id: ID!) {
      node(id: $id) {
        ... on BulkOperation { id status errorCode objectCount url partialDataUrl }
      }
    }`,
    { id },
  );
  if (!data.node) throw new Error(`Bulk operation ${id} not found while polling.`);
  return data.node;
}

// ── JSONL result parsing (by __lineNumber) ───────────────────────────────────

/** A built JSONL payload plus the per-line references used to map each result
 *  line back to its source record. `R` is whatever the caller keys results on
 *  (e.g. a CSV row number, or a customer id). Line index i ↔ lineRefs[i]. */
export interface BuiltJsonl<R> {
  jsonl: string;
  lineRefs: R[];
}

/** One parsed result line handed to the caller's parseLine. */
export interface BulkResultLine<R> {
  /** The source reference for this line (lineRefs[idx]); undefined if unmatched. */
  ref: R | undefined;
  /** The mutation payload container: `line.data ?? line`. */
  data: Record<string, unknown>;
  /** The full JSONL line — a top-level `message` lives here for error lines. */
  raw: Record<string, unknown>;
}

/** Download a completed bulk operation's result file and parse it line by line,
 *  mapping each line back to its source ref via __lineNumber, then delegating the
 *  entity-specific shaping to `parseLine`. Robust to 0- or 1-based __lineNumber. */
export async function fetchAndParseBulkResults<R, O>(
  url: string,
  lineRefs: R[],
  parseLine: (line: BulkResultLine<R>) => O,
): Promise<O[]> {
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
  // minimum so the row mapping is robust either way. Fold with a loop rather
  // than Math.min(...lineNumbers) — spreading a large result set (100k+ lines)
  // passes every element as an argument and overflows the engine's argument
  // limit ("Maximum call stack size exceeded").
  //
  // ⚠ THIS ASSUMES THE RESULT FILE STARTS AT THE FIRST LINE.
  // It holds for a COMPLETED operation's `url`, which always does. It does NOT
  // hold for `partialDataUrl` on a FAILED/CANCELED op, whose first line may be
  // any line number. Feeding partial data through here collapses `base` to that
  // first line, shifting EVERY ref: results get attributed to the wrong source
  // rows, silently, with no error. Before wiring up partial-result salvage, pass
  // the true base in explicitly instead of inferring it. Pinned by
  // test/shopifyBulk.test.ts ("MISALIGNS refs ... partial data").
  let base = Infinity;
  for (const p of parsed) {
    const n = Number(p.__lineNumber);
    if (n < base) base = n;
  }

  return parsed.map((line) => {
    const idx = Number(line.__lineNumber) - base;
    const ref = lineRefs[idx];
    const data = (line.data ?? line) as Record<string, unknown>;
    return parseLine({ ref, data, raw: line });
  });
}

// ── parallel batch split ─────────────────────────────────────────────────────

// Contiguous, balanced split (earlier batches get the +1 when it doesn't divide
// evenly). Deterministic given the asc-ordered items + n, so a later reconcile can
// recompute any job's exact slice from (batchIndex, batchCount) without storing it.
export function splitIntoBatches<T>(items: T[], n: number): T[][] {
  const batches: T[][] = Array.from({ length: Math.max(n, 0) }, () => []);
  if (n <= 0) return batches;
  const base = Math.floor(items.length / n);
  const remainder = items.length % n;
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (i < remainder ? 1 : 0);
    batches[i] = items.slice(idx, idx + size);
    idx += size;
  }
  return batches;
}
