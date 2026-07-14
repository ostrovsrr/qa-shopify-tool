import { v4 as uuidv4 } from 'uuid';
import type { CleanupRun, ImportBatchJob } from '@prisma/client';
import prisma from '../db/prisma';
import { buildTemplateDataset } from '../reports/templateDataset';
import { TemplateRow } from '../reports/mergeDuplicates';
import { getShopifyConfig } from '../config/shopify';
import { purgedMessage } from './retention.service';
import {
  acquireStoreLock,
  acquireStoreLocks,
  releaseStoreLock,
  renewStoreLock,
  StoreBusyError,
} from './storeLock.service';
import {
  adoptRow,
  claimRow,
  failRow,
  findResumableRows,
  ResumableStore,
} from './importResume.service';
import { getImportFeedback, ImportFeedback } from './importFeedback.service';
import {
  BuiltJsonl,
  BulkResultLine,
  fetchAndParseBulkResults,
  fetchBulkOperationState,
  MAX_JOB_POLL_ATTEMPTS,
  runBulkMutation,
  splitIntoBatches,
  stagedUpload,
  TERMINAL_BULK_STATUSES,
} from './shopifyBulk';
import { qaImportTagForRun } from './shopifyCleanup.service';
import { startCleanupRuns } from './cleanupRun.service';
import {
  getShopifyClient,
  ShopifyAuthError,
  ShopifyConfigError,
} from './shopifyClient';

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
}

/** Build the final rows the import sends to Shopify — the same transformation
 *  the Excel "Shopify Template" sheet applies (column mapping + optional
 *  same-person merge + optional move-duplicates-to-Notes), so the store import
 *  tests exactly the file the user would hand to Shopify. The HeliosMigrated
 *  tag is intentionally NOT applied here: it's a migration marker, not part of
 *  the QA comparison, and test-store customers already get their own qa tags. */
function buildImportRows(run: ImportSourceRun): TemplateRow[] {
  return buildTemplateDataset({
    originalRows: run.originalRows,
    columnMapping: run.columnMapping as Record<string, string> | null,
    moveDuplicatesToNotes: run.moveDuplicatesToNotes ?? false,
    mergeMatchingDuplicates: run.mergeMatchingDuplicates ?? false,
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
 *  userErrors carry no `code`, so we synthesize a stable one from the message. */
function parseCustomerCreateLine(
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
    const message =
      typeof line.raw.message === 'string' ? line.raw.message : 'Unknown bulk error.';
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

// Kicks off the Shopify bulk operation and persists the run as RUNNING, then
// returns immediately. The op is finalized later by reconcileImportRun (driven
// by the GET poll), so no HTTP request is held open while Shopify processes.
export async function startCustomerImport(
  validationId: string,
  storeId: string,
): Promise<RunImportResult> {
  const run = await prisma.validationRun.findUnique({
    where: { id: validationId },
    include: { originalRows: { orderBy: { rowNumber: 'asc' } } },
  });
  if (!run) return { notFound: true };

  // Throws ShopifyConfigError (handled by controller) if env is unset.
  const client = await getShopifyClient(storeId);
  const health = await client.verifyConnection();
  if (!health.ok) {
    return { ok: false, error: health.error ?? 'Shopify connection not healthy.' };
  }

  const importRunId = uuidv4();
  const { jsonl, lineRefs } = buildJsonl(buildImportRows(run), importRunId);

  if (lineRefs.length === 0) {
    return {
      ok: false,
      // A purged run has no rows for a reason, and 'no rows to import' would read
      // like a bug in the upload rather than the retention policy doing its job.
      error: run.piiPurgedAt ? purgedMessage() : 'This validation run has no rows to import.',
    };
  }

  // ── PRE-PERSIST before the side effect. Same rule as the batch path.
  //
  //    The bulk op creates real customers in a real store. Submitting it before
  //    the run row exists means a crash in between leaves the op RUNNING on
  //    Shopify with NO database row at all: the user sees nothing happened, while
  //    customers land in the store tagged qa-import-<importRunId> — an id that
  //    only ever existed in memory. Untracked, unreconcilable, and invisible to
  //    the run-scoped cleanup.
  //
  //    Never take a side effect you have not recorded. The row goes down first,
  //    as PENDING; the op id lands on it the moment Shopify hands one back.
  //
  //    The store's busy-lock is taken in the SAME transaction. If someone else is
  //    already working this store, the transaction rolls back and no row is written
  //    at all — the caller just gets told the store is busy. Locking after the
  //    pre-persist would leave an orphan PENDING row that resume-on-boot would
  //    later try to launch. Note the lock keys on the RESOLVED store id, so an
  //    omitted storeId (which silently means "the first store") contends with an
  //    explicit one for the same store.
  try {
    await prisma.$transaction(async (tx) => {
      await acquireStoreLock(tx, storeId, {
        ownerType: 'IMPORT_RUN',
        ownerId: importRunId,
        operation: 'a customer import',
      });
      await tx.importRun.create({
        data: {
          id: importRunId,
          validationId,
          storeId,
          shopDomain: health.shop ?? shopDomainFor(storeId),
          bulkOperationId: null,
          status: 'PENDING',
          successCount: 0,
          errorCount: 0,
        },
      });
    });
  } catch (err) {
    if (err instanceof StoreBusyError) return { ok: false, busy: true, error: err.message };
    throw err;
  }

  try {
    await submitSingleStoreRun(importRunId, client, jsonl);
  } catch (err) {
    const message = (err as Error).message;
    await prisma.importRun.update({
      where: { id: importRunId },
      data: { status: 'FAILED', error: message },
    });
    // The run is over before it began — hand the store straight back rather than
    // making the next colleague wait out the lock TTL.
    await releaseStoreLock(importRunId);
    return { ok: false, error: message };
  }

  return { ok: true, importRunId };
}

/**
 * Submit a pre-persisted single-store run's bulk op and record its id.
 *
 * Shared by the first launch and by resume-on-boot, so a relaunched run takes the
 * exact same path as an original one — no second implementation to drift.
 */
async function submitSingleStoreRun(
  importRunId: string,
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  jsonl: string,
): Promise<void> {
  // Queue the op (seconds-scale); do NOT wait for it to finish here.
  const stagedPath = await stagedUpload(client, jsonl, 'bulk_customers.jsonl');
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

/** Row numbers the validator flagged, for the four-bucket comparison. When
 *  move-duplicates-to-Notes was on, the duplicated emails/phones were stripped
 *  before the import, so DuplicateEmail/DuplicatePhone flags are resolved and
 *  must not count — otherwise every handled duplicate shows up as a "false
 *  positive" (flagged but accepted). Merge-only runs keep the flags: unmerged
 *  duplicates still hit Shopify raw, same as before. */
function flaggedRowsForRun(run: {
  moveDuplicatesToNotes?: boolean;
  issues: { rowNumber: number; issueType: string }[];
}): Set<number> {
  const duplicatesResolved = run.moveDuplicatesToNotes ?? false;
  const rows = new Set<number>();
  for (const issue of run.issues) {
    if (
      duplicatesResolved &&
      (issue.issueType === 'DuplicateEmail' || issue.issueType === 'DuplicatePhone')
    ) {
      continue;
    }
    rows.add(issue.rowNumber);
  }
  return rows;
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

  const client = await getShopifyClient(run.storeId ?? undefined);
  const state = await fetchBulkOperationState(client, run.bulkOperationId);

  // Still queued/processing — leave it RUNNING.
  if (!TERMINAL_BULK_STATUSES.includes(state.status)) {
    // Someone is demonstrably still watching this run, so push the lock's expiry
    // out. The TTL only exists to free a store nobody is finishing; it must never
    // pull the store out from under an operation that is plainly still alive.
    await renewStoreLock(importRunId);
    return getImportFeedback(importRunId);
  }

  if (state.status === 'COMPLETED') {
    await finalizeCompletedRun(importRunId, state.url);
  } else {
    // FAILED / CANCELED / EXPIRED — record the terminal status + reason.
    const error = `Bulk operation ${state.status}${
      state.errorCode ? ` (${state.errorCode})` : ''
    }.`;
    await prisma.importRun.updateMany({
      where: { id: importRunId, status: 'RUNNING' },
      data: { status: state.status, error },
    });
  }

  // Terminal either way — the store is free.
  await releaseStoreLock(importRunId);

  return getImportFeedback(importRunId);
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
// RUNNING → COMPLETED transition (updateMany returns count: 0 if another poll
// already finalized), keeping concurrent reconciles idempotent.
async function finalizeCompletedRun(
  importRunId: string,
  resultUrl: string | null,
): Promise<void> {
  const run = await prisma.importRun.findUnique({
    where: { id: importRunId },
    include: {
      validationRun: {
        include: {
          originalRows: { orderBy: { rowNumber: 'asc' } },
          issues: { select: { rowNumber: true, issueType: true } },
        },
      },
    },
  });
  if (!run || run.status !== 'RUNNING') return;

  const lineRefs = lineToRowFromRun(run.validationRun);
  const outcomes = resultUrl
    ? await fetchAndParseBulkResults(resultUrl, lineRefs, parseCustomerCreateLine)
    : [];

  const flaggedRows = flaggedRowsForRun(run.validationRun);
  const successCount = outcomes.filter((o) => o.accepted).length;
  const errorCount = outcomes.length - successCount;

  await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.importRun.updateMany({
        where: { id: importRunId, status: 'RUNNING' },
        data: { status: 'COMPLETED', successCount, errorCount },
      });
      // Another concurrent reconcile already finalized this run — don't double-insert.
      if (claimed.count === 0) return;

      const rows = outcomes.map((o) => ({
        id: uuidv4(),
        importRunId,
        storeId: run.storeId,
        rowNumber: o.rowNumber,
        accepted: o.accepted,
        shopifyCustomerId: o.shopifyCustomerId,
        shopifyCode: o.shopifyCode,
        shopifyField: o.shopifyField,
        message: o.message,
        wasFlaggedByValidator: flaggedRows.has(o.rowNumber),
      }));

      // Chunk the insert so a single multi-row INSERT doesn't dominate the
      // transaction budget on large runs (66k+ rows blew the 5s default).
      const CHUNK = 5000;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.importRowResult.createMany({ data: rows.slice(i, i + CHUNK) });
      }
    },
    // Large runs need far more than the 5s interactive-transaction default.
    { timeout: 120_000, maxWait: 10_000 },
  );
}

// ── parallel batch import across multiple stores ─────────────────────────────

// Splits the run's rows across the selected stores and kicks off one bulk op per
// store in parallel. Returns immediately with a parent ImportRun id; the per-store
// jobs are finalized and merged into the parent's rowResults by the reconcile poll.
export async function startBatchImport(
  validationId: string,
  storeIds: string[],
): Promise<RunImportResult> {
  const run = await prisma.validationRun.findUnique({
    where: { id: validationId },
    include: { originalRows: { orderBy: { rowNumber: 'asc' } } },
  });
  if (!run) return { notFound: true };
  if (storeIds.length === 0) return { ok: false, error: 'Select at least one store.' };
  if (run.originalRows.length === 0) {
    return {
      ok: false,
      // A purged run has no rows for a reason, and 'no rows to import' would read
      // like a bug in the upload rather than the retention policy doing its job.
      error: run.piiPurgedAt ? purgedMessage() : 'This validation run has no rows to import.',
    };
  }

  const parentId = uuidv4();
  // Transform BEFORE splitting: merging is cross-row, so it must see the whole
  // dataset — and the reconcile recomputes the same split over the same
  // transformed rows to map results back.
  const batches = splitIntoBatches(buildImportRows(run), storeIds.length);

  // ── 1. PLAN the jobs. No Shopify calls: every field here comes from the
  //       validation run or from env config, so this cannot fail halfway through.
  const planned = storeIds
    .map((storeId, index) => ({
      id: uuidv4(),
      storeId,
      index,
      batch: batches[index] ?? [],
      // The shop domain is in env config, so we do NOT need verifyConnection() to
      // know it. That is what lets the whole plan be persisted before we talk to
      // Shopify at all.
      shopDomain: shopDomainFor(storeId),
    }))
    .filter((p) => p.batch.length > 0); // fewer rows than stores

  if (planned.length === 0) {
    return { ok: false, error: 'No rows to import.' };
  }

  // ── 2. PRE-PERSIST the parent and EVERY job as PENDING, in ONE transaction,
  //       BEFORE any Shopify call.
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
  //       is told which store to wait for. Each JOB owns its store's lock (not the
  //       parent, whose storeId is legitimately NULL), so locks are released one by
  //       one as each store's job finishes.
  try {
    await prisma.$transaction(async (tx) => {
      await acquireStoreLocks(
        tx,
        planned.map((p) => p.storeId),
        (storeId) => ({
          ownerType: 'IMPORT_JOB',
          ownerId: planned.find((p) => p.storeId === storeId)!.id,
          operation: 'a customer import',
        }),
      );
      await tx.importRun.create({
        data: {
          id: parentId,
          validationId,
          // NULL is correct here and stays correct: a batch parent spans many stores.
          storeId: null,
          shopDomain: planned.map((p) => p.shopDomain).join(', ').slice(0, 250),
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
              batchCount: storeIds.length,
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

  // ── 3. FAN OUT. Each job moves PENDING → RUNNING (with its bulk op id) or
  //       PENDING → FAILED. A per-store failure is captured on that job rather
  //       than aborting the batch, which would strand the bulk ops already
  //       started on the other stores.
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
  try {
    const client = await getShopifyClient(storeId);
    const health = await client.verifyConnection();
    if (!health.ok) {
      await prisma.importBatchJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error: health.error ?? 'Store not healthy.' },
      });
      // This job is terminal — free its store immediately.
      await releaseStoreLock(jobId);
      return;
    }

    const { jsonl } = buildJsonl(batch, parentId);
    const stagedPath = await stagedUpload(client, jsonl, 'bulk_customers.jsonl');
    const bulkOpId = await runBulkMutation(client, CUSTOMER_CREATE_MUTATION, stagedPath);

    // The gap between runBulkMutation returning and this write landing is the one
    // window where a crash leaves a bulk op running on Shopify that we have no id
    // for. Resume-on-boot closes it by ADOPTING the shop's currentBulkOperation
    // rather than submitting a second one (Shopify allows only one per shop, so a
    // naive re-submit would just fail).
    await prisma.importBatchJob.update({
      where: { id: jobId },
      data: {
        status: 'RUNNING',
        bulkOperationId: bulkOpId,
        shopDomain: health.shop ?? shopDomainFor(storeId),
      },
    });
  } catch (err) {
    await prisma.importBatchJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', error: (err as Error).message },
    });
    await releaseStoreLock(jobId);
  }
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

    // Bound stuck jobs: count this poll and fail the job once it's been checked
    // too many times without reaching a terminal state.
    const attempts = job.pollAttempts + 1;
    if (attempts > MAX_JOB_POLL_ATTEMPTS) {
      await prisma.importBatchJob.updateMany({
        where: { id: job.id, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          error: `Timed out: still running after ${MAX_JOB_POLL_ATTEMPTS} status checks.`,
        },
      });
      await releaseStoreLock(job.id);
      continue;
    }
    await prisma.importBatchJob.update({
      where: { id: job.id },
      data: { pollAttempts: attempts },
    });

    // Isolate each job: one store erroring must not abort the others' progress.
    try {
      const client = await getShopifyClient(job.storeId ?? undefined);
      const state = await fetchBulkOperationState(client, job.bulkOperationId);
      if (!TERMINAL_BULK_STATUSES.includes(state.status)) {
        // Still alive and still being watched — keep its store held.
        await renewStoreLock(job.id);
        continue;
      }

      if (state.status === 'COMPLETED') {
        await finalizeCompletedJob(parentId, job, state.url);
      } else {
        await prisma.importBatchJob.updateMany({
          where: { id: job.id, status: 'RUNNING' },
          data: {
            status: state.status,
            error: `Bulk operation ${state.status}${state.errorCode ? ` (${state.errorCode})` : ''}.`,
          },
        });
      }
      // This job is terminal — free ITS store, while the batch's other stores stay
      // locked by their own jobs.
      await releaseStoreLock(job.id);
    } catch (err) {
      // Persistent errors (bad token/config) fail just this job so the batch can
      // still finish; transient errors are left RUNNING to retry on the next poll.
      if (err instanceof ShopifyAuthError || err instanceof ShopifyConfigError) {
        await prisma.importBatchJob.updateMany({
          where: { id: job.id, status: 'RUNNING' },
          data: { status: 'FAILED', error: (err as Error).message },
        });
        await releaseStoreLock(job.id);
      }
    }
  }

  // Roll up: re-read jobs and recompute parent counts from the merged rowResults.
  const fresh = await prisma.importBatchJob.findMany({ where: { importRunId: parentId } });
  const allTerminal = fresh.every((j) => TERMINAL_BULK_STATUSES.includes(j.status));
  const merged = await prisma.importRowResult.findMany({
    where: { importRunId: parentId },
    select: { accepted: true },
  });
  const successCount = merged.filter((r) => r.accepted).length;
  const errorCount = merged.length - successCount;

  if (allTerminal) {
    const failedJobs = fresh.filter((j) => j.status !== 'COMPLETED');
    const error = failedJobs.length
      ? failedJobs
          .map((j) => `${j.shopDomain}: ${j.error ?? j.status}`)
          .join(' | ')
          .slice(0, 500)
      : null;
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

// Parses one completed job's results and merges them into the parent's
// rowResults — guarded by the job's RUNNING → COMPLETED transition so concurrent
// polls insert exactly once.
async function finalizeCompletedJob(
  parentId: string,
  job: ImportBatchJob,
  resultUrl: string | null,
): Promise<void> {
  const parent = await prisma.importRun.findUnique({
    where: { id: parentId },
    include: {
      validationRun: {
        include: {
          originalRows: { orderBy: { rowNumber: 'asc' } },
          issues: { select: { rowNumber: true, issueType: true } },
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
    ? await fetchAndParseBulkResults(resultUrl, lineRefs, parseCustomerCreateLine)
    : [];

  const flaggedRows = flaggedRowsForRun(parent.validationRun);
  const successCount = outcomes.filter((o) => o.accepted).length;
  const errorCount = outcomes.length - successCount;

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.importBatchJob.updateMany({
      where: { id: job.id, status: 'RUNNING' },
      data: { status: 'COMPLETED', successCount, errorCount },
    });
    if (claimed.count === 0) return; // another poll already merged this job
    await tx.importRowResult.createMany({
      data: outcomes.map((o) => ({
        id: uuidv4(),
        importRunId: parentId,
        storeId: job.storeId,
        rowNumber: o.rowNumber,
        accepted: o.accepted,
        shopifyCustomerId: o.shopifyCustomerId,
        shopifyCode: o.shopifyCode,
        shopifyField: o.shopifyField,
        message: o.message,
        wasFlaggedByValidator: flaggedRows.has(o.rowNumber),
      })),
    });
  });
}

// ── crash recovery (resume-on-boot) ──────────────────────────────────────────
//
// The customer twins of productImport's resume stores. A PENDING row means "we
// wrote the row but have no bulk op id for it" — the process died between the two.
// importResume decides, per row, whether the op was actually submitted (adopt it)
// or never reached Shopify (relaunch it).

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

  await submitSingleStoreRun(runId, client, jsonl);
}

export function customerResumableStores(): ResumableStore[] {
  return [
    {
      label: 'customer-run',
      findResumable: (staleBefore) => findResumableRows(prisma.importRun as never, staleBefore),
      claim: (id, staleBefore) => claimRow(prisma.importRun as never, id, staleBefore),
      adopt: (id, bulkOperationId) => adoptRow(prisma.importRun as never, id, bulkOperationId),
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
      findResumable: (staleBefore) => findResumableRows(prisma.importBatchJob as never, staleBefore),
      claim: (id, staleBefore) => claimRow(prisma.importBatchJob as never, id, staleBefore),
      adopt: (id, bulkOperationId) => adoptRow(prisma.importBatchJob as never, id, bulkOperationId),
      relaunch: relaunchCustomerJob,
      fail: (id, error) => failRow(prisma.importBatchJob as never, id, error),
      lockOwner: (row) => ({
        ownerType: 'IMPORT_JOB',
        ownerId: row.id,
        operation: 'a customer import',
      }),
    },
  ];
}
