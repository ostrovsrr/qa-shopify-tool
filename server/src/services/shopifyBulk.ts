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

/** A bulk op plus when Shopify created it. The timestamp is what lets resume decide
 *  whether the shop's current operation is the one a crashed job submitted. */
export interface CurrentBulkOperation extends BulkOperationState {
  createdAt: string;
}

/**
 * The shop's most recent MUTATION bulk operation, or null if it has never run one.
 *
 * This is the key to safe crash recovery. Shopify allows exactly ONE bulk operation
 * per shop, so if a job died between submitting its op and persisting the returned
 * id, that op is still the shop's current one. Resume ADOPTS it (see
 * importResume.service.ts) instead of submitting a second — which would just fail
 * against the per-shop limit (see runBulkMutation's "already in progress" path) or,
 * worse, duplicate a merchant's import.
 */
export async function fetchCurrentBulkOperation(
  client: ShopifyClient,
): Promise<CurrentBulkOperation | null> {
  const data = await client.query<{ currentBulkOperation: CurrentBulkOperation | null }>(
    `query currentBulk {
      currentBulkOperation(type: MUTATION) {
        id status errorCode objectCount url partialDataUrl createdAt
      }
    }`,
  );
  return data.currentBulkOperation ?? null;
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
  /** The source reference for this line (lineRefs[idx]). */
  ref: R;
  /** The mutation payload container: `line.data ?? line`. */
  data: Record<string, unknown>;
  /** The full JSONL line — a top-level `message` lives here for error lines. */
  raw: Record<string, unknown>;
}

/**
 * Completed result files start at their first input line, so their 0/1 base can
 * be detected safely. Partial files may start anywhere and must state the true
 * base explicitly or every result can shift to the wrong source row.
 */
export type BulkResultSource =
  | { kind: 'complete' }
  | { kind: 'partial'; lineNumberBase: 0 | 1 };

/** Download a completed bulk operation's result file and parse it line by line,
 *  mapping each line back to its source ref via __lineNumber, then delegating the
 *  entity-specific shaping to `parseLine`. Robust to 0- or 1-based __lineNumber. */
export async function fetchAndParseBulkResults<R, O>(
  url: string,
  lineRefs: R[],
  source: BulkResultSource,
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

  const numbered = parsed.map((line, index) => {
    const lineNumber = Number(line.__lineNumber);
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 0) {
      throw new Error(`Bulk result line ${index + 1} has an invalid __lineNumber.`);
    }
    return { line, lineNumber };
  });

  let base: number;
  if (source.kind === 'partial') {
    base = source.lineNumberBase;
  } else {
    // Fold rather than spreading a 100k+ line result as function arguments.
    base = Infinity;
    for (const item of numbered) {
      if (item.lineNumber < base) base = item.lineNumber;
    }
    if (base !== 0 && base !== 1) {
      throw new Error(
        `Completed bulk result starts at __lineNumber ${base}; refusing to infer a base from what may be partial data.`,
      );
    }
  }

  return numbered.map(({ line, lineNumber }) => {
    const idx = lineNumber - base;
    const ref = lineRefs[idx];
    if (idx < 0 || idx >= lineRefs.length || ref === undefined) {
      throw new Error(
        `Bulk result __lineNumber ${lineNumber} does not map to one of the ${lineRefs.length} submitted lines.`,
      );
    }
    const data = (line.data ?? line) as Record<string, unknown>;
    return parseLine({ ref, data, raw: line });
  });
}

// ── blocking poll-to-terminal (cleanup only) ─────────────────────────────────

// Bulk-op poll cadence + cap for the BLOCKING path. ~150 * 2s ≈ 5 min.
//
// ⚠ This blocks the HTTP request for up to 300s. That is deliberate today and
// fine on localhost, but a hosted platform proxy times out around 100s, so the
// cleanup routes CANNOT work hosted in this shape. The import services already
// solved this: they persist the bulk-op id and advance one step per reconcile
// call (see `MAX_JOB_POLL_ATTEMPTS` and the `pollAttempts` column). Cleanup
// should be converted to that same model — these constants disappear when it is.
export const BULK_POLL_INTERVAL_MS = 2000;
export const MAX_BULK_POLL_ATTEMPTS = 150;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Block until a bulk operation reaches a terminal status, then return its result
 * file URL. Throws if it times out, ends non-COMPLETED, or completes with no file.
 *
 * `label` only shapes the error text (callers say "Bulk delete").
 */
export async function awaitBulkOperationResultUrl(
  client: ShopifyClient,
  bulkOpId: string,
  label = 'Bulk delete',
): Promise<string> {
  let state = await fetchBulkOperationState(client, bulkOpId);
  for (
    let attempt = 0;
    !TERMINAL_BULK_STATUSES.includes(state.status) && attempt < MAX_BULK_POLL_ATTEMPTS;
    attempt++
  ) {
    await sleep(BULK_POLL_INTERVAL_MS);
    state = await fetchBulkOperationState(client, bulkOpId);
  }

  if (!TERMINAL_BULK_STATUSES.includes(state.status)) {
    throw new Error(
      `${label} did not finish within ${(MAX_BULK_POLL_ATTEMPTS * BULK_POLL_INTERVAL_MS) / 1000}s; ` +
        'it may still be running on Shopify — re-run cleanup shortly.',
    );
  }
  if (state.status !== 'COMPLETED') {
    throw new Error(`${label} ${state.status}${state.errorCode ? ` (${state.errorCode})` : ''}.`);
  }
  if (!state.url) {
    throw new Error(`${label} completed but Shopify returned no result file.`);
  }
  return state.url;
}

// ── bulk delete-by-id ────────────────────────────────────────────────────────

/** One id that failed to delete, with Shopify's reason. Callers rename `id` to
 *  their own key (customerId / productId). */
export interface BulkDeleteFailure {
  id: string;
  message: string;
}

export interface BulkDeleteOutcome {
  deleted: number;
  errors: BulkDeleteFailure[];
}

/** The entity-specific bits of a delete-by-id bulk op. */
export interface BulkDeleteSpec {
  /** e.g. the customerDelete / productDelete mutation string. */
  mutation: string;
  /** JSONL filename for the staged upload (cosmetic; aids debugging in Shopify). */
  filename: string;
  /** Mutation payload key on each result line, e.g. 'customerDelete'. */
  payloadKey: string;
  /** Deleted-id field inside that payload, e.g. 'deletedCustomerId'. */
  deletedIdKey: string;
}

/**
 * Stage the ids and kick off the delete. Returns the bulk operation id WITHOUT
 * waiting for it to finish — the caller persists that id and advances the
 * operation one step per poll (see cleanupRun.service.ts).
 *
 * This is the non-blocking half. Blocking in-request for up to 300s is what makes
 * the cleanup routes unusable behind a hosting proxy that gives up around 100s.
 */
export async function submitBulkDelete(
  client: ShopifyClient,
  ids: string[],
  spec: BulkDeleteSpec,
): Promise<string> {
  const jsonl = ids.map((id) => JSON.stringify({ input: { id } })).join('\n');
  const stagedPath = await stagedUpload(client, jsonl, spec.filename);
  return runBulkMutation(client, spec.mutation, stagedPath);
}

/** Fold a finished delete operation's result file into a deleted count + errors. */
export async function parseBulkDeleteResults(
  url: string,
  ids: string[],
  spec: BulkDeleteSpec,
): Promise<BulkDeleteOutcome> {
  type LineOutcome = { ok: boolean; id: string; message?: string };

  const outcomes = await fetchAndParseBulkResults<string, LineOutcome>(
    url,
    ids,
    { kind: 'complete' },
    ({ ref, data, raw }) => {
      const payload = data[spec.payloadKey] as
        | (Record<string, unknown> & { userErrors: { message: string }[] })
        | undefined;

      if (!payload) {
        // Top-level error line (e.g. malformed input) — no mutation payload.
        const message =
          typeof raw.message === 'string' ? raw.message : 'Unknown bulk delete error.';
        return { ok: false, id: ref ?? 'unknown', message };
      }

      const deletedId = payload[spec.deletedIdKey] as string | null | undefined;
      if (payload.userErrors.length === 0 && deletedId) {
        return { ok: true, id: ref ?? deletedId };
      }

      const message =
        payload.userErrors.map((e) => e.message).join('; ') || 'Delete rejected by Shopify.';
      return { ok: false, id: ref ?? 'unknown', message };
    },
  );

  const errors: BulkDeleteFailure[] = [];
  let deleted = 0;
  for (const o of outcomes) {
    if (o.ok) {
      deleted++;
    } else {
      errors.push({ id: o.id, message: o.message ?? 'Unknown delete failure.' });
    }
  }
  return { deleted, errors };
}

/**
 * Submit a delete and BLOCK until it finishes.
 *
 * ⚠ Blocks the request for up to 300s (see awaitBulkOperationResultUrl). Kept only
 * for callers that are already synchronous and small. The hosted cleanup path uses
 * submitBulkDelete + parseBulkDeleteResults and polls instead.
 */
export async function bulkDeleteByIds(
  client: ShopifyClient,
  ids: string[],
  spec: BulkDeleteSpec,
): Promise<BulkDeleteOutcome> {
  const bulkOpId = await submitBulkDelete(client, ids, spec);
  const url = await awaitBulkOperationResultUrl(client, bulkOpId);
  return parseBulkDeleteResults(url, ids, spec);
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
