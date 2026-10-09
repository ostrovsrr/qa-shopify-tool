import { v4 as uuidv4 } from 'uuid';
import type { CleanupRun, ImportBatchJob } from '@prisma/client';
import prisma from '../db/prisma';
import { buildTemplateDataset } from '../reports/templateDataset';
import { TemplateRow } from '../reports/mergeDuplicates';
import { getShopifyConfig } from '../config/shopify';
import { purgedMessage } from './retention.service';
import {
  acquireStoreLocks,
  releaseShareIfDone,
  releaseStoreLock,
  renewStoreLock,
  shareOwner,
  StoreBusyError,
} from './storeLock.service';
import {
  claimRow,
  failRow,
  findResumableRows,
  markSubmitAttempt,
  recordAmbiguousSubmit,
  ResumableStore,
} from './importResume.service';
import { getImportFeedback, ImportFeedback } from './importFeedback.service';
import {
  BuiltJsonl,
  BulkOperationState,
  BulkResultLine,
  BulkResultSource,
  bulkLineErrorMessage,
  fetchAndParseBulkResults,
  opsForStore,
  opsForStoreOnShop,
  runBulkMutation,
  splitIntoBatches,
  stagedUpload,
  TERMINAL_BULK_STATUSES,
} from './shopifyBulk';
import { QA_IMPORT_TAG, qaImportTagForRun } from './shopifyCleanup.service';
import { startCleanupRuns } from './cleanupRun.service';
import { getShopifyClient } from './shopifyClient';
import {
  advanceImportOp,
  AMBIGUOUS_SUBMIT_MESSAGE,
  isAmbiguousSubmitError,
} from './importReconcile';

// Strict create so duplicates surface as TAKEN against the empty test store.
// userErrors here is plain UserError (no `code`) — we synthesize a stable code
// from the message tail so feedback can aggregate on (field, code), not message.
const CUSTOMER_CREATE_MUTATION =
  'mutation call($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }';

// Every created customer carries QA_IMPORT_TAG plus its run's qaImportTagForRun
// tag, so the whole import is reversible (batch-delete by tag during teardown).
// Both come from the cleanup module: the tag the import writes and the tag the
// cleanup deletes by must be one definition, not two copies that can drift.

// Rows written per createMany inside a result-merge transaction. A single
// multi-row INSERT of a large run blew the 5s interactive-transaction default.
const INSERT_CHUNK = 5000;
// Interactive-transaction budget for writing a large run's results.
const RESULT_TX_OPTIONS = { timeout: 120_000, maxWait: 10_000 };

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
  // `busy` = a store is already in use (the busy-lock refused). Distinct from a
  // plain error because it is not a failure: it is a 409 the user can retry.
  | { ok: false; error: string; busy?: boolean }
  | { ok: true; importRunId: string };

// ── value helpers ────────────────────────────────────────────────────────────

// The validation run fields the import dataset is derived from. Deterministic:
// start, reconcile, batch split, and batch reconcile all rebuild the exact same
// rows (and therefore the same JSONL line ↔ CSV row mapping) from these.
interface ImportSourceRun {
  originalRows: OriginalRowRecord[];
  columnMapping: unknown;
  moveDuplicatesToNotes?: boolean;
  mergeMatchingDuplicates?: boolean;
  moveInvalidContactToNotes?: boolean;
  fillMissingContactName?: boolean;
}

/** Build the final rows the import sends to Shopify — the same transformation
 *  the Excel "Shopify Template" sheet applies (column mapping + optional
 *  same-person merge + optional move-invalid-to-Notes + optional
 *  move-duplicates-to-Notes + optional placeholder names), so the store import
 *  tests exactly the file the user would hand to Shopify. The HeliosMigrated
 *  tag is intentionally NOT applied here: it's a migration marker, not part of
 *  the QA comparison, and test-store customers already get their own qa tags. */
function buildImportRows(run: ImportSourceRun): TemplateRow[] {
  return buildTemplateDataset({
    originalRows: run.originalRows,
    columnMapping: run.columnMapping as Record<string, string> | null,
    moveDuplicatesToNotes: run.moveDuplicatesToNotes ?? false,
    mergeMatchingDuplicates: run.mergeMatchingDuplicates ?? false,
    moveInvalidContactToNotes: run.moveInvalidContactToNotes ?? false,
    fillMissingContactName: run.fillMissingContactName ?? false,
  }).rows;
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
  const tags = [QA_IMPORT_TAG, qaImportTagForRun(importRunId), ...csvTags];

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

/** Build the JSONL bulk payload (one `{"input": CustomerInput}` line per row)
 *  plus the per-line refs (CSV row numbers) the engine maps results back to.
 *  Rows are the final import rows from buildImportRows — records are already
 *  Shopify-column-keyed with merge/move-to-Notes applied. */
function buildJsonl(rows: TemplateRow[], importRunId: string): BuiltJsonl<number> {
  const lines: string[] = [];
  const lineRefs: number[] = [];
  for (const row of rows) {
    const input = buildCustomerInput(row.record, importRunId);
    lines.push(JSON.stringify({ input }));
    lineRefs.push(row.rowNumber);
  }
  return { jsonl: lines.join('\n'), lineRefs };
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

// ── result-line parser for the generic engine ────────────────────────────────

/** Parse one customerCreate result line into a per-row outcome. customerCreate
 *  userErrors carry no `code`, so we synthesize a stable one from the message.
 *  Exported for tests. */
export function parseCustomerCreateLine(
  line: BulkResultLine<number>,
): ImportRowOutcome {
  const rowNumber = line.ref ?? -1;

  const payload = line.data.customerCreate as
    | {
        customer: { id: string } | null;
        userErrors: { field: unknown; message: string }[];
      }
    | undefined;

  if (!payload) {
    // Top-level error line (e.g. malformed variables) — treat as rejected.
    const message = bulkLineErrorMessage(line.raw, 'Unknown bulk error.');
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
}

// ── orchestrator: start (fast) ───────────────────────────────────────────────

// Start a customer import into ONE store. It is a one-store batch: same planner,
// same pre-persist, same k-ops-per-store split as a parallel import, so the store's
// share runs as up to BULK_OPS_PER_STORE concurrent bulk ops instead of one. The
// result is a batch parent + jobs, finalized later by reconcileImportRun (driven by
// the GET poll), so no HTTP request is held open while Shopify processes.
//
// What it keeps from the old single-run path is its front door: the store's health
// is checked first, and an unhealthy store is reported here with Shopify's own
// message rather than as a job that failed. A launch failure after that (a refused
// or ambiguous submit) lands on the job and reaches the user through the poll, as
// for any batch. The old single-run submit (submitSingleStoreRun) is no longer
// reached for new runs; it and the single-run reconcile stay so runs written
// before this change still drain.
export async function startCustomerImport(
  validationId: string,
  storeId: string,
): Promise<RunImportResult> {
  // Existence only: startBatchImport loads the rows, and a large run's rows are not
  // worth reading twice.
  const run = await prisma.validationRun.findUnique({
    where: { id: validationId },
    select: { id: true },
  });
  if (!run) return { notFound: true };

  // Throws ShopifyConfigError (handled by controller) if env is unset.
  const client = await getShopifyClient(storeId);
  const health = await client.verifyConnection();
  if (!health.ok) {
    return { ok: false, error: health.error ?? 'Shopify connection not healthy.' };
  }

  return startBatchImport(validationId, [storeId]);
}

/**
 * Submit a pre-persisted single-store run's bulk op and record its id.
 *
 * Only resume-on-boot reaches this now: new single-store imports are one-store
 * batches (see startCustomerImport). It stays for a single run written before that
 * change and left PENDING across the deploy.
 */
async function submitSingleStoreRun(
  importRunId: string,
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  jsonl: string,
): Promise<void> {
  // Queue the op (seconds-scale); do NOT wait for it to finish here.
  const stagedPath = await stagedUpload(client, jsonl, 'bulk_customers.jsonl');
  // Intent before the side effect — see decideResume in importResume.service.ts.
  await markSubmitAttempt(prisma.importRun as never, importRunId);
  const bulkOpId = await runBulkMutation(client, CUSTOMER_CREATE_MUTATION, stagedPath);

  await prisma.importRun.update({
    where: { id: importRunId },
    data: { status: 'RUNNING', bulkOperationId: bulkOpId },
  });
}

// ── orchestrator: reconcile (advances at most one step) ──────────────────────

// lineToRow is recomputed deterministically from the run's original rows via
// the same buildImportRows transformation buildJsonl used (merging can drop
// rows, so raw row numbers would be misaligned), so it need not be persisted
// across requests.
function lineToRowFromRun(run: ImportSourceRun): number[] {
  return buildImportRows(run).map((r) => r.rowNumber);
}

// Called by the GET poll. If the run is already terminal it just returns current
// feedback; otherwise it pokes Shopify once and, when the op is done, finalizes
// the run. Finalization is guarded so concurrent polls can't double-write.
export async function reconcileImportRun(
  importRunId: string,
): Promise<ImportFeedback | null> {
  const run = await prisma.importRun.findUnique({
    where: { id: importRunId },
    include: { batchJobs: true },
  });
  if (!run) return null;
  if (TERMINAL_BULK_STATUSES.includes(run.status)) {
    return getImportFeedback(importRunId);
  }

  // A batch parent has no bulk op of its own — advance its children instead.
  if (run.batchJobs.length > 0) {
    return reconcileBatchRun(importRunId, run.batchJobs);
  }
  // Shouldn't happen for a single run, but guard the now-nullable column.
  if (!run.bulkOperationId) {
    return getImportFeedback(importRunId);
  }

  // Same per-op handling as a batch job: errors isolated, permanent failures
  // (bad token, vanished op, unreadable results) fail the run and free its store,
  // transient ones retry within the time bound, and a colleague's run — reopened
  // from the shared History — is left alone. See advanceImportOp.
  await advanceImportOp({
    label: `customer run ${importRunId}`,
    storeId: run.storeId,
    bulkOperationId: run.bulkOperationId,
    startedAt: run.submitAttemptedAt ?? run.createdAt,
    onCompleted: (state) => finalizeRun(importRunId, 'COMPLETED', null, state.url, { kind: 'complete' }),
    onEnded: (state, error) => finalizeEndedRun(importRunId, state, error),
    onFailed: async (error) => {
      await prisma.importRun.updateMany({
        where: { id: importRunId, status: 'RUNNING' },
        data: { status: 'FAILED', error },
      });
    },
    renewLock: () => renewStoreLock(importRunId),
    releaseLock: () => releaseStoreLock(importRunId),
  });

  return getImportFeedback(importRunId);
}

/**
 * An op that ended FAILED / CANCELED / EXPIRED may still have created records
 * before it stopped. Shopify hands those lines back as partialDataUrl; ingesting
 * them is what lets the report show what is actually in the store (and lets the
 * run-scoped cleanup be checked against it), instead of "0 imported" over a store
 * holding thousands of qa-import customers. The run keeps its terminal status and
 * error either way — partial results are evidence, not success.
 *
 * Reading the partial file is best-effort: if it cannot be read, the run is still
 * recorded as ended, with no rows, exactly as before.
 */
async function finalizeEndedRun(
  importRunId: string,
  state: BulkOperationState,
  error: string,
): Promise<void> {
  try {
    await finalizeRun(importRunId, state.status, error, state.partialDataUrl, { kind: 'partial' });
  } catch (err) {
    console.warn(`[import] partial results for ${importRunId} unreadable:`, (err as Error).message);
    await prisma.importRun.updateMany({
      where: { id: importRunId, status: 'RUNNING' },
      data: { status: state.status, error },
    });
  }
}

// Resume/show the most recent import for a validation run — used when reopening
// a run from History. Reconciles so a still-RUNNING import is advanced (and a
// COMPLETED one is returned without re-hitting Shopify).
export async function reconcileLatestImportForValidation(
  validationId: string,
): Promise<ImportFeedback | null> {
  const latest = await prisma.importRun.findFirst({
    where: { validationId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!latest) return null;
  return reconcileImportRun(latest.id);
}

// Deletes the customers created by an import run, across every store it touched.
// A batch spreads its customers over all its jobs' stores (all sharing the
// qa-import-<importRunId> tag); a single run uses its own store (or the caller's
// fallback). Results are aggregated into one CleanupResult the client renders
// unchanged.
/**
 * Reverse one import: delete every customer it created, across every store it
 * touched. The product twin lives in productImport.service.ts.
 *
 * Returns the cleanup runs to poll rather than a finished result — a teardown of a
 * real migration is a bulk delete that can take minutes, and waiting for it inside
 * the request is what made this route impossible to host (a proxy gives up around
 * 100s; the old code polled for up to 300).
 */
export async function cleanupImportRunStores(
  importRunId: string,
  fallbackStoreId?: string,
): Promise<CleanupRun[]> {
  const run = await prisma.importRun.findUnique({
    where: { id: importRunId },
    include: { batchJobs: { select: { storeId: true } } },
  });
  const tag = qaImportTagForRun(importRunId);

  const storeIds: (string | undefined)[] =
    run && run.batchJobs.length > 0
      ? [...new Set(run.batchJobs.map((j) => j.storeId ?? undefined))]
      : [run?.storeId ?? fallbackStoreId];

  return startCleanupRuns('CUSTOMER', storeIds, tag, importRunId);
}

// Download + parse results and write rowResults, but only if THIS call wins the
// RUNNING → terminal transition (updateMany returns count: 0 if another poll
// already finalized), keeping concurrent reconciles idempotent. `status` is
// COMPLETED for a finished op, or the op's own FAILED / CANCELED / EXPIRED when
// ingesting its partial results.
async function finalizeRun(
  importRunId: string,
  status: string,
  error: string | null,
  resultUrl: string | null,
  source: BulkResultSource,
): Promise<void> {
  const run = await prisma.importRun.findUnique({
    where: { id: importRunId },
    include: {
      validationRun: {
        include: {
          originalRows: { orderBy: { rowNumber: 'asc' } },
        },
      },
    },
  });
  if (!run || run.status !== 'RUNNING') return;

  const lineRefs = lineToRowFromRun(run.validationRun);
  const outcomes = resultUrl
    ? await fetchAndParseBulkResults(resultUrl, lineRefs, source, parseCustomerCreateLine)
    : [];

  await writeRowResults(
    outcomes,
    { importRunId, storeId: run.storeId },
    (tx, successCount, errorCount) =>
      tx.importRun.updateMany({
        where: { id: importRunId, status: 'RUNNING' },
        data: { status, error, successCount, errorCount },
      }),
  );
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Write one op's outcomes as rowResults, in the same transaction that claims the
 * owning run/job's RUNNING → terminal transition. `claim` returns count 0 when a
 * concurrent poll got there first, and then nothing is inserted.
 *
 * Shared by the single-run and batch-job paths so both chunk the insert and both
 * get the long transaction budget; the batch path once did neither, and a large
 * job's single INSERT blew the 5s default and was retried on every poll.
 */
async function writeRowResults(
  outcomes: ImportRowOutcome[],
  target: { importRunId: string; storeId: string | null },
  claim: (tx: Tx, successCount: number, errorCount: number) => Promise<{ count: number }>,
): Promise<void> {
  const successCount = outcomes.filter((o) => o.accepted).length;
  const errorCount = outcomes.length - successCount;

  await prisma.$transaction(async (tx) => {
    const claimed = await claim(tx, successCount, errorCount);
    // Another concurrent reconcile already finalized this — don't double-insert.
    if (claimed.count === 0) return;

    const rows = outcomes.map((o) => ({
      id: uuidv4(),
      importRunId: target.importRunId,
      storeId: target.storeId,
      rowNumber: o.rowNumber,
      accepted: o.accepted,
      shopifyCustomerId: o.shopifyCustomerId,
      shopifyCode: o.shopifyCode,
      shopifyField: o.shopifyField,
      message: o.message,
    }));

    // Chunk the insert so a single multi-row INSERT doesn't dominate the
    // transaction budget on large runs (66k+ rows blew the 5s default).
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.importRowResult.createMany({ data: rows.slice(i, i + INSERT_CHUNK) });
    }
  }, RESULT_TX_OPTIONS);
}

// ── parallel batch import across multiple stores ─────────────────────────────

// Splits the run's rows across the selected stores, and each store's share across k
// concurrent bulk ops, and kicks them all off in parallel. Returns immediately with
// a parent ImportRun id; the jobs are finalized and merged into the parent's
// rowResults by the reconcile poll. A single-store import is this with one store.
export async function startBatchImport(
  validationId: string,
  storeIds: string[],
): Promise<RunImportResult> {
  const run = await prisma.validationRun.findUnique({
    where: { id: validationId },
    include: { originalRows: { orderBy: { rowNumber: 'asc' } } },
  });
  if (!run) return { notFound: true };
  // One share per store. A repeated id would plan two shares of the same shop — each
  // sized as if it had the shop's bulk-op slots to itself — under ONE lock
  // (acquireStoreLocks dedupes).
  storeIds = [...new Set(storeIds)];
  if (storeIds.length === 0) return { ok: false, error: 'Select at least one store.' };
  if (run.originalRows.length === 0) {
    return {
      ok: false,
      // A purged run has no rows for a reason, and 'no rows to import' would read
      // like a bug in the upload rather than the retention policy doing its job.
      error: run.piiPurgedAt ? purgedMessage(run.piiPurgedAt) : 'This validation run has no rows to import.',
    };
  }

  const parentId = uuidv4();
  // Transform BEFORE splitting: merging is cross-row, so it must see the whole
  // dataset — and the reconcile recomputes the same split over the same
  // transformed rows to map results back.
  const rows = buildImportRows(run);

  // ── 1. SIZE each store's share: k bulk ops per store, k the SAME for every
  //       store. finalizeJob and resume recompute a job's rows from nothing but
  //       (batchIndex, batchCount) over one flat split, so the stores × k slices
  //       must be one splitIntoBatches call — which only stays balanced per store if
  //       every store has the same k. The minimum is the one every store can take.
  //
  //       Read-only Shopify calls (counting ops already running on each shop), and
  //       best effort: a store we cannot build a client for is sized without that
  //       count, and its launch below records the real failure on its jobs.
  const perStore = Math.ceil(rows.length / storeIds.length);
  const clients = await Promise.all(
    storeIds.map((storeId) => getShopifyClient(storeId).catch(() => null)),
  );
  const minOps = Math.min(
    ...(await Promise.all(
      clients.map((client) => (client ? opsForStoreOnShop(client, perStore) : opsForStore(perStore))),
    )),
  );
  // Cap k so every selected store gets work: with fewer rows than stores × k the
  // flat split leaves the trailing slices empty, and those are whole stores idle
  // (lock taken for nothing, absent from the parent shopDomain). With fewer rows
  // than stores some store goes without whatever k is, so k stays 1 there.
  const k = Math.max(1, Math.min(minOps, Math.floor(rows.length / storeIds.length)));
  const batchCount = storeIds.length * k;
  const batches = splitIntoBatches(rows, batchCount);

  // ── 2. PLAN the jobs: slice i → store i mod stores (round-robin), so each store
  //       gets k slices. Not k contiguous slices per store: splitIntoBatches gives
  //       its +1 remainders to the EARLIEST slices, and dealt in blocks of k they
  //       all land on the first store(s) — off by up to k-1 rows from the per-store
  //       plan the client previews (batchSizeFor). Dealt round-robin, store j's
  //       total is exactly splitIntoBatches(n, stores)[j]. Finalize and resume
  //       index by batchIndex alone, so nothing needs a store's rows contiguous.
  //       No side effect yet: every field comes from the validation run, env
  //       config, or the clients built above.
  const domainOf = new Map(
    storeIds.map((storeId, s) => [storeId, clients[s]?.shop ?? shopDomainFor(storeId)]),
  );
  const planned = batches
    .map((batch, index) => {
      const storeId = storeIds[index % storeIds.length];
      return { id: uuidv4(), storeId, index, batch, shopDomain: domainOf.get(storeId)! };
    })
    .filter((p) => p.batch.length > 0); // fewer rows than slices

  if (planned.length === 0) {
    return { ok: false, error: 'No rows to import.' };
  }
  const plannedStores = [...new Set(planned.map((p) => p.storeId))];

  // ── 3. PRE-PERSIST the parent and EVERY job as PENDING, in ONE transaction,
  //       BEFORE any Shopify side effect.
  //
  //       reconcileBatchRun rolls the parent up when every job it FINDS IN THE DB
  //       is terminal. That check cannot tell "all 5 jobs finished" apart from
  //       "only 2 jobs were ever written, and both finished". So if jobs are
  //       written as they complete, a crash mid-fan-out leaves 2 of 5 rows, the
  //       rollup agrees, and the parent goes COMPLETED — reporting a successful
  //       import of stores that never received a single customer.
  //
  //       Writing all N jobs up front as PENDING makes that impossible: PENDING is
  //       not in TERMINAL_BULK_STATUSES, so the unstarted jobs hold the rollup
  //       open. Mirrors productImport.service.ts (the two flows are twins).
  //       Pinned by test/integration/batchRollup.test.ts.
  //
  //       Every store's busy-lock is taken in the SAME transaction, ALL OR NOTHING.
  //       Fanning out to the four free stores and failing the busy one would be a
  //       partial fan-out — precisely the half-done, half-reported work the PENDING
  //       pre-persist exists to make impossible. If any store is busy the whole
  //       transaction rolls back, nothing is written, no lock is held, and the user
  //       is told which store to wait for.
  //
  //       Each store's SHARE owns its lock — the set of this run's jobs on that
  //       store — not any one job (the first of k siblings to finish would free the
  //       store under the rest) and not the parent (whose storeId is legitimately
  //       NULL). A store is freed when the last job of its share is terminal
  //       (releaseShareIfDone), and every job carries its storeId, since a job
  //       without one is invisible to its share.
  try {
    await prisma.$transaction(async (tx) => {
      await acquireStoreLocks(tx, plannedStores, (storeId) => ({
        ownerType: 'IMPORT_STORE_SHARE',
        ownerId: shareOwner(parentId, storeId),
        operation: 'a customer import',
      }));
      await tx.importRun.create({
        data: {
          id: parentId,
          validationId,
          // NULL is correct here and stays correct: a batch parent spans many stores.
          storeId: null,
          shopDomain: plannedStores.map((s) => domainOf.get(s)!).join(', ').slice(0, 250),
          bulkOperationId: null,
          status: 'RUNNING',
          successCount: 0,
          errorCount: 0,
          batchJobs: {
            create: planned.map((p) => ({
              id: p.id,
              storeId: p.storeId,
              shopDomain: p.shopDomain,
              batchIndex: p.index,
              batchCount,
              bulkOperationId: null,
              status: 'PENDING',
              error: null,
              rowCount: p.batch.length,
              successCount: 0,
              errorCount: 0,
            })),
          },
        },
      });
    });
  } catch (err) {
    if (err instanceof StoreBusyError) return { ok: false, busy: true, error: err.message };
    throw err;
  }

  // ── 4. FAN OUT — only now that every job of every share is on disk. Each job
  //       moves PENDING → RUNNING (with its bulk op id) or PENDING → FAILED. A
  //       per-job failure is captured on that job rather than aborting the batch,
  //       which would strand the bulk ops already started by its siblings.
  await Promise.all(planned.map((p) => launchBatchJob(p.id, p.storeId, p.batch, parentId)));

  return { ok: true, importRunId: parentId };
}

/** Resolve a store's shop domain from env config, without touching the network.
 *  Falls back to the store id so a misconfigured store still yields a row. */
function shopDomainFor(storeId: string): string {
  const result = getShopifyConfig(storeId);
  return result.ok ? result.config.shop : storeId;
}

/**
 * Start one pre-persisted batch job: verify the store, stage the JSONL, submit the
 * bulk mutation, and record the bulk operation id.
 *
 * The job row already exists (PENDING) before this runs, so every exit path here
 * is an UPDATE. If the process dies part-way, the row stays PENDING — non-terminal,
 * so it holds the parent's rollup open — and resume-on-boot picks it up.
 *
 * Mirrors launchBatchJob in productImport.service.ts.
 */
async function launchBatchJob(
  jobId: string,
  storeId: string,
  batch: TemplateRow[],
  parentId: string,
): Promise<void> {
  // Set the moment Shopify hands back an op id. A throw after that is NOT a refused
  // submit — the op exists and may be running — so the catch must not treat it as
  // one (see below).
  let bulkOpId: string | null = null;
  try {
    const client = await getShopifyClient(storeId);
    const health = await client.verifyConnection();
    if (!health.ok) {
      await prisma.importBatchJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error: health.error ?? 'Store not healthy.' },
      });
      // This job is terminal (and that write is committed) — free its store if it
      // was the last of its share.
      await releaseJobStore(jobId, parentId, storeId);
      return;
    }

    const { jsonl } = buildJsonl(batch, parentId);
    const stagedPath = await stagedUpload(client, jsonl, 'bulk_customers.jsonl');
    // Intent before the side effect. From here until the update below lands, a
    // crash leaves an op on Shopify that we may have no id for — and the shop cannot
    // tell us which op is ours. Resume-on-boot sees submitAttemptedAt and fails the
    // job honestly instead of guessing (see decideResume in importResume.service.ts).
    await markSubmitAttempt(prisma.importBatchJob as never, jobId);
    bulkOpId = await runBulkMutation(client, CUSTOMER_CREATE_MUTATION, stagedPath);

    await prisma.importBatchJob.update({
      where: { id: jobId },
      data: {
        status: 'RUNNING',
        bulkOperationId: bulkOpId,
        shopDomain: health.shop ?? shopDomainFor(storeId),
      },
    });
  } catch (err) {
    if (bulkOpId) {
      // Shopify ACCEPTED the op; recording its id is what failed. The op may be
      // running on the store right now, so this is the outcome-unknown case, not a
      // refusal: leave the job PENDING with submitAttemptedAt set, and its share
      // holding the store, exactly as an ambiguous submit does — the sweep settles
      // it once the lock's TTL has run out. Clearing submitAttemptedAt or releasing
      // here would hand the store to the next colleague on top of a live op.
      console.warn(
        `[import] customer job ${jobId}: bulk op ${bulkOpId} submitted but not recorded:`,
        (err as Error).message,
      );
      await recordAmbiguousSubmit(
        prisma.importBatchJob as never,
        jobId,
        `${AMBIGUOUS_SUBMIT_MESSAGE} (Shopify started ${bulkOpId}; recording it failed: ${(err as Error).message})`,
      ).catch(() => undefined); // the DB just failed us once; the row is already right
      return;
    }
    if (isAmbiguousSubmitError(err)) {
      // The op may be live on this store. Do NOT go terminal and do NOT release:
      // the job stays PENDING with submitAttemptedAt set — the "outcome unknown"
      // state importResume already defines — so its share keeps the store until
      // the lock's TTL, after which the sweep fails it with this message.
      await recordAmbiguousSubmit(
        prisma.importBatchJob as never,
        jobId,
        `${AMBIGUOUS_SUBMIT_MESSAGE} (${(err as Error).message})`,
      );
      return;
    }
    // A definite failure: Shopify refused the submit (or we never got as far as
    // it), so nothing is running for this job. submitAttemptedAt is cleared to say
    // exactly that — a FAILED job that keeps it with no op id reads as "failed while
    // submitting, may still be running", and the share would then hold the store
    // to the TTL over an op that was never started.
    await prisma.importBatchJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', error: (err as Error).message, submitAttemptedAt: null },
    });
    await releaseJobStore(jobId, parentId, storeId);
  }
}

/**
 * Free a terminal job's store — if it was the last of its share to finish.
 *
 * Call only once the job's terminal status is COMMITTED: releaseShareIfDone judges
 * the share from the database, so two siblings finishing together each see the
 * other's write and the later one frees the store. Read before the commit, both
 * would see a live sibling and the store would stay locked until the TTL.
 *
 * The job-id release frees a lock taken before shares existed (owned by the job
 * itself), so batches started before this change still drain; for any newer job
 * it matches nothing.
 */
async function releaseJobStore(jobId: string, parentId: string, storeId: string | null): Promise<void> {
  if (storeId) await releaseShareIfDone('customer', parentId, storeId);
  await releaseStoreLock(jobId);
}

/** Push out the lock a running job's store is held by — its share's, or, for a job
 *  started before shares existed, its own. */
async function renewJobStore(jobId: string, parentId: string, storeId: string | null): Promise<void> {
  if (storeId) await renewStoreLock(shareOwner(parentId, storeId));
  await renewStoreLock(jobId);
}

// Advances a batch parent: polls each non-terminal job once, merges completed
// ones into the parent's rowResults, and rolls the parent status up when every
// job is terminal (FAILED if any job didn't COMPLETE).
async function reconcileBatchRun(
  parentId: string,
  jobs: ImportBatchJob[],
): Promise<ImportFeedback | null> {
  for (const job of jobs) {
    if (TERMINAL_BULK_STATUSES.includes(job.status)) continue;
    if (!job.bulkOperationId) continue; // never started → already effectively failed

    // Each job is advanced on its own: one store erroring must not abort the
    // others' progress, and a job on a store this instance has no token for — a
    // colleague's, seen through the shared History or the sweep — is skipped, never
    // failed. A stuck job is bounded by time since its submit, not by how often it
    // was polled, and is never failed while Shopify still reports it RUNNING. See
    // advanceImportOp. (pollAttempts is no longer read or written here.)
    await advanceImportOp({
      label: `customer job ${job.id}`,
      storeId: job.storeId,
      bulkOperationId: job.bulkOperationId,
      startedAt: job.submitAttemptedAt ?? job.createdAt,
      onCompleted: (state) => finalizeJob(parentId, job, 'COMPLETED', null, state.url, { kind: 'complete' }),
      onEnded: async (state, error) => {
        // Partial results are best-effort — see finalizeEndedRun.
        try {
          await finalizeJob(parentId, job, state.status, error, state.partialDataUrl, { kind: 'partial' });
        } catch (err) {
          console.warn(`[import] partial results for job ${job.id} unreadable:`, (err as Error).message);
          await prisma.importBatchJob.updateMany({
            where: { id: job.id, status: 'RUNNING' },
            data: { status: state.status, error },
          });
        }
      },
      onFailed: async (error) => {
        await prisma.importBatchJob.updateMany({
          where: { id: job.id, status: 'RUNNING' },
          data: { status: 'FAILED', error },
        });
      },
      renewLock: () => renewJobStore(job.id, parentId, job.storeId),
      // This job is terminal — advanceImportOp calls this only after onCompleted /
      // onEnded / onFailed have committed that — so free its store if it was the
      // last of its share. Siblings, and the batch's other stores, stay held.
      releaseLock: () => releaseJobStore(job.id, parentId, job.storeId),
    });
  }

  // Roll up: re-read jobs and recompute parent counts from the merged rowResults —
  // counted in the database, not by loading every row of a large import per poll.
  const fresh = await prisma.importBatchJob.findMany({
    where: { importRunId: parentId },
    orderBy: { batchIndex: 'asc' },
  });
  const allTerminal = fresh.every((j) => TERMINAL_BULK_STATUSES.includes(j.status));
  const [successCount, totalCount] = await Promise.all([
    prisma.importRowResult.count({ where: { importRunId: parentId, accepted: true } }),
    prisma.importRowResult.count({ where: { importRunId: parentId } }),
  ]);
  const errorCount = totalCount - successCount;

  if (allTerminal) {
    const failedJobs = fresh.filter((j) => j.status !== 'COMPLETED');
    // One entry per failed STORE (its first failed job): a store runs up to k jobs,
    // and k copies of one store's error would crowd the other stores out of the
    // 500 characters.
    const failedStores = new Map<string, string>();
    for (const j of failedJobs) {
      if (!failedStores.has(j.shopDomain)) failedStores.set(j.shopDomain, `${j.shopDomain}: ${j.error ?? j.status}`);
    }
    const error = failedJobs.length ? [...failedStores.values()].join(' | ').slice(0, 500) : null;
    await prisma.importRun.updateMany({
      where: { id: parentId, status: 'RUNNING' },
      data: {
        status: failedJobs.length ? 'FAILED' : 'COMPLETED',
        successCount,
        errorCount,
        error,
      },
    });
  } else {
    // Keep partial counts fresh so the header reflects progress as jobs land.
    await prisma.importRun.updateMany({
      where: { id: parentId, status: 'RUNNING' },
      data: { successCount, errorCount },
    });
  }

  return getImportFeedback(parentId);
}

// Parses one finished job's results (complete, or partial for an op that ended
// FAILED / CANCELED / EXPIRED) and merges them into the parent's rowResults —
// guarded by the job's RUNNING → terminal transition so concurrent polls insert
// exactly once.
async function finalizeJob(
  parentId: string,
  job: ImportBatchJob,
  status: string,
  error: string | null,
  resultUrl: string | null,
  source: BulkResultSource,
): Promise<void> {
  const parent = await prisma.importRun.findUnique({
    where: { id: parentId },
    include: {
      validationRun: {
        include: {
          originalRows: { orderBy: { rowNumber: 'asc' } },
        },
      },
    },
  });
  if (!parent) return;

  // Same transform + split as startBatchImport → this job's exact rows → lineToRow.
  const slice =
    splitIntoBatches(buildImportRows(parent.validationRun), job.batchCount)[job.batchIndex] ?? [];
  const lineRefs = slice.map((r) => r.rowNumber);
  const outcomes = resultUrl
    ? await fetchAndParseBulkResults(resultUrl, lineRefs, source, parseCustomerCreateLine)
    : [];

  await writeRowResults(
    outcomes,
    { importRunId: parentId, storeId: job.storeId },
    (tx, successCount, errorCount) =>
      tx.importBatchJob.updateMany({
        where: { id: job.id, status: 'RUNNING' },
        data: { status, error, successCount, errorCount },
      }),
  );
}

// ── crash recovery (resume-on-boot) ──────────────────────────────────────────
//
// The customer twins of productImport's resume stores. A PENDING row means "we
// wrote the row but have no bulk op id for it" — the process died between the two.
// importResume decides, per row, from submitAttemptedAt alone: never attempted
// (relaunch it) or submit outcome unknown (fail it, never guess).

/**
 * Relaunch a batch job whose op never reached Shopify.
 *
 * The slice is NOT stored — it is recomputed from (batchIndex, batchCount) via
 * splitIntoBatches over the same transformed rows, which is deterministic. That
 * determinism (pinned by test/shopifyBulk.test.ts, and already relied on by the
 * reconcile) is what makes resume possible without persisting every job's rows.
 */
async function relaunchCustomerJob(jobId: string): Promise<void> {
  const job = await prisma.importBatchJob.findUnique({
    where: { id: jobId },
    include: {
      importRun: {
        include: { validationRun: { include: { originalRows: { orderBy: { rowNumber: 'asc' } } } } },
      },
    },
  });
  if (!job) return;
  if (!job.storeId) {
    await prisma.importBatchJob.updateMany({
      where: { id: jobId, status: 'PENDING' },
      data: { status: 'FAILED', error: 'Cannot resume: job has no store.' },
    });
    return;
  }

  const rows = buildImportRows(job.importRun.validationRun);
  const batch = splitIntoBatches(rows, job.batchCount)[job.batchIndex] ?? [];
  if (batch.length === 0) {
    await prisma.importBatchJob.updateMany({
      where: { id: jobId, status: 'PENDING' },
      data: { status: 'FAILED', error: 'Cannot resume: no rows in this batch slice.' },
    });
    return;
  }

  // Same path as the original launch — no second implementation to drift.
  await launchBatchJob(jobId, job.storeId, batch, job.importRunId);
}

/** Relaunch a single-store run whose op never reached Shopify. */
async function relaunchCustomerRun(runId: string): Promise<void> {
  const run = await prisma.importRun.findUnique({
    where: { id: runId },
    include: { validationRun: { include: { originalRows: { orderBy: { rowNumber: 'asc' } } } } },
  });
  if (!run) return;

  const client = await getShopifyClient(run.storeId ?? undefined);
  const { jsonl, lineRefs } = buildJsonl(buildImportRows(run.validationRun), runId);
  if (lineRefs.length === 0) {
    await prisma.importRun.updateMany({
      where: { id: runId, status: 'PENDING' },
      data: { status: 'FAILED', error: 'Cannot resume: this validation run has no rows to import.' },
    });
    return;
  }

  try {
    await submitSingleStoreRun(runId, client, jsonl);
  } catch (err) {
    // An ambiguous relaunch is left PENDING with its store held, like a live
    // one (see startCustomerImport) — resume's catch would otherwise fail it and
    // free the store under an op that may be running.
    if (!isAmbiguousSubmitError(err)) throw err;
    await recordAmbiguousSubmit(
      prisma.importRun as never,
      runId,
      `${AMBIGUOUS_SUBMIT_MESSAGE} (${(err as Error).message})`,
    );
  }
}

export function customerResumableStores(): ResumableStore[] {
  return [
    {
      label: 'customer-run',
      findResumable: (staleBefore) => findResumableRows(prisma.importRun as never, staleBefore),
      claim: (id, staleBefore) => claimRow(prisma.importRun as never, id, staleBefore),
      relaunch: relaunchCustomerRun,
      fail: (id, error) => failRow(prisma.importRun as never, id, error),
      lockOwner: (row) => ({
        ownerType: 'IMPORT_RUN',
        ownerId: row.id,
        operation: 'a customer import',
      }),
    },
    {
      label: 'customer-job',
      findResumable: (staleBefore) =>
        findResumableRows(prisma.importBatchJob as never, staleBefore, { withParent: true }),
      claim: (id, staleBefore) => claimRow(prisma.importBatchJob as never, id, staleBefore),
      relaunch: relaunchCustomerJob,
      fail: (id, error) => failRow(prisma.importBatchJob as never, id, error),
      // A job's store is held by its SHARE, so two PENDING siblings on one store both
      // re-take the same lock (re-entrant) instead of the second being told the
      // store is busy by its own sibling. A job with no store has no share; it
      // falls back to its own id, and the relaunch fails it anyway.
      lockOwner: (row) =>
        row.importRunId && row.storeId
          ? {
              ownerType: 'IMPORT_STORE_SHARE',
              ownerId: shareOwner(row.importRunId, row.storeId),
              operation: 'a customer import',
            }
          : { ownerType: 'IMPORT_JOB', ownerId: row.id, operation: 'a customer import' },
    },
  ];
}
