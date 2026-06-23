import { v4 as uuidv4 } from 'uuid';
import type { ImportBatchJob } from '@prisma/client';
import prisma from '../db/prisma';
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
import {
  cleanupCustomersByTag,
  CleanupResult,
  qaImportTagForRun,
} from './shopifyCleanup.service';
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

/** Build the JSONL bulk payload (one `{"input": CustomerInput}` line per row)
 *  plus the per-line refs (CSV row numbers) the engine maps results back to. */
function buildJsonl(
  rows: OriginalRowRecord[],
  mapping: Record<string, string> | null | undefined,
  importRunId: string,
): BuiltJsonl<number> {
  const lines: string[] = [];
  const lineRefs: number[] = [];
  for (const row of rows) {
    const original = (row.data ?? {}) as Record<string, string>;
    const mapped = mapRecord(original, mapping);
    const input = buildCustomerInput(mapped, importRunId);
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
  storeId?: string,
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
  const { jsonl, lineRefs } = buildJsonl(
    run.originalRows,
    run.columnMapping as Record<string, string> | null,
    importRunId,
  );

  if (lineRefs.length === 0) {
    return { ok: false, error: 'This validation run has no rows to import.' };
  }

  // Queue the op (seconds-scale); do NOT wait for it to finish here.
  const stagedPath = await stagedUpload(client, jsonl, 'bulk_customers.jsonl');
  const bulkOpId = await runBulkMutation(client, CUSTOMER_CREATE_MUTATION, stagedPath);

  await prisma.importRun.create({
    data: {
      id: importRunId,
      validationId,
      storeId: storeId ?? null,
      shopDomain: health.shop ?? '',
      bulkOperationId: bulkOpId,
      status: 'RUNNING',
      successCount: 0,
      errorCount: 0,
    },
  });

  return { ok: true, importRunId };
}

// ── orchestrator: reconcile (advances at most one step) ──────────────────────

// lineToRow is recomputed deterministically from the run's original rows (same
// asc ordering buildJsonl used), so it need not be persisted across requests.
function lineToRowFromRows(rows: OriginalRowRecord[]): number[] {
  return rows.map((r) => r.rowNumber);
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
export async function cleanupImportRunStores(
  importRunId: string,
  fallbackStoreId?: string,
): Promise<CleanupResult> {
  const run = await prisma.importRun.findUnique({
    where: { id: importRunId },
    include: { batchJobs: { select: { storeId: true } } },
  });
  const tag = qaImportTagForRun(importRunId);

  const storeIds: (string | undefined)[] =
    run && run.batchJobs.length > 0
      ? [...new Set(run.batchJobs.map((j) => j.storeId ?? undefined))]
      : [run?.storeId ?? fallbackStoreId];

  const results: CleanupResult[] = [];
  for (const storeId of storeIds) {
    results.push(await cleanupCustomersByTag(storeId, tag));
  }

  if (results.length === 1) return results[0];
  return {
    storeId: undefined,
    shop: results.map((r) => r.shop).join(', '),
    tag,
    found: results.reduce((n, r) => n + r.found, 0),
    deleted: results.reduce((n, r) => n + r.deleted, 0),
    failed: results.reduce((n, r) => n + r.failed, 0),
    errors: results.flatMap((r) => r.errors),
  };
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
          issues: { select: { rowNumber: true } },
        },
      },
    },
  });
  if (!run || run.status !== 'RUNNING') return;

  const lineRefs = lineToRowFromRows(run.validationRun.originalRows);
  const outcomes = resultUrl
    ? await fetchAndParseBulkResults(resultUrl, lineRefs, parseCustomerCreateLine)
    : [];

  const flaggedRows = new Set(run.validationRun.issues.map((i) => i.rowNumber));
  const successCount = outcomes.filter((o) => o.accepted).length;
  const errorCount = outcomes.length - successCount;

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.importRun.updateMany({
      where: { id: importRunId, status: 'RUNNING' },
      data: { status: 'COMPLETED', successCount, errorCount },
    });
    // Another concurrent reconcile already finalized this run — don't double-insert.
    if (claimed.count === 0) return;

    await tx.importRowResult.createMany({
      data: outcomes.map((o) => ({
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
      })),
    });
  });
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
    return { ok: false, error: 'This validation run has no rows to import.' };
  }

  const parentId = uuidv4();
  const mapping = run.columnMapping as Record<string, string> | null;
  const batches = splitIntoBatches(run.originalRows, storeIds.length);

  // Per-store failure is captured as a FAILED job rather than aborting the whole
  // batch (which would strand the bulk ops already started on other stores).
  const jobs = await Promise.all(
    storeIds.map(async (storeId, index) => {
      const batch = batches[index] ?? [];
      if (batch.length === 0) return null; // fewer rows than stores
      try {
        const client = await getShopifyClient(storeId);
        const health = await client.verifyConnection();
        if (!health.ok) {
          return {
            storeId,
            index,
            shopDomain: health.shop ?? storeId,
            batchCount: storeIds.length,
            bulkOperationId: null as string | null,
            status: 'FAILED',
            error: health.error ?? 'Store not healthy.',
            rowCount: batch.length,
          };
        }
        const { jsonl } = buildJsonl(batch, mapping, parentId);
        const stagedPath = await stagedUpload(client, jsonl, 'bulk_customers.jsonl');
        const bulkOpId = await runBulkMutation(client, CUSTOMER_CREATE_MUTATION, stagedPath);
        return {
          storeId,
          index,
          shopDomain: health.shop ?? storeId,
          batchCount: storeIds.length,
          bulkOperationId: bulkOpId as string | null,
          status: 'RUNNING',
          error: null as string | null,
          rowCount: batch.length,
        };
      } catch (err) {
        return {
          storeId,
          index,
          shopDomain: storeId,
          batchCount: storeIds.length,
          bulkOperationId: null as string | null,
          status: 'FAILED',
          error: (err as Error).message,
          rowCount: batch.length,
        };
      }
    }),
  );

  const realJobs = jobs.filter((j): j is NonNullable<typeof j> => j !== null);
  if (realJobs.length === 0) {
    return { ok: false, error: 'No rows to import.' };
  }

  await prisma.importRun.create({
    data: {
      id: parentId,
      validationId,
      storeId: null,
      shopDomain: realJobs.map((j) => j.shopDomain).join(', ').slice(0, 250),
      bulkOperationId: null,
      status: 'RUNNING',
      successCount: 0,
      errorCount: 0,
      batchJobs: {
        create: realJobs.map((j) => ({
          id: uuidv4(),
          storeId: j.storeId,
          shopDomain: j.shopDomain,
          batchIndex: j.index,
          batchCount: j.batchCount,
          bulkOperationId: j.bulkOperationId,
          status: j.status,
          error: j.error,
          rowCount: j.rowCount,
          successCount: 0,
          errorCount: 0,
        })),
      },
    },
  });

  return { ok: true, importRunId: parentId };
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
      if (!TERMINAL_BULK_STATUSES.includes(state.status)) continue;

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
    } catch (err) {
      // Persistent errors (bad token/config) fail just this job so the batch can
      // still finish; transient errors are left RUNNING to retry on the next poll.
      if (err instanceof ShopifyAuthError || err instanceof ShopifyConfigError) {
        await prisma.importBatchJob.updateMany({
          where: { id: job.id, status: 'RUNNING' },
          data: { status: 'FAILED', error: (err as Error).message },
        });
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
          issues: { select: { rowNumber: true } },
        },
      },
    },
  });
  if (!parent) return;

  // Same split as startBatchImport → this job's exact rows → lineToRow.
  const slice =
    splitIntoBatches(parent.validationRun.originalRows, job.batchCount)[job.batchIndex] ?? [];
  const lineRefs = slice.map((r) => r.rowNumber);
  const outcomes = resultUrl
    ? await fetchAndParseBulkResults(resultUrl, lineRefs, parseCustomerCreateLine)
    : [];

  const flaggedRows = new Set(parent.validationRun.issues.map((i) => i.rowNumber));
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
