import { v4 as uuidv4 } from 'uuid';
import type { CleanupRun, ProductImportJob } from '@prisma/client';
import prisma from '../db/prisma';
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
import { col, extractMetafields, groupByHandle } from './productCsvParser';
import {
  getShopifyClient,
  ShopifyAuthError,
  ShopifyConfigError,
} from './shopifyClient';
import { getShopifyConfig } from '../config/shopify';
import {
  adoptRow,
  claimRow,
  failRow,
  findResumableRows,
  ResumableStore,
} from './importResume.service';
import { getProductImportFeedback, ProductImportFeedback } from './productFeedback.service';
import { startCleanupRuns } from './cleanupRun.service';
import { normalizeRecord } from '../utils/normalize';
import { ProductCsvRow, ProductGroup, ProductImportOutcome } from '../types';

// Product-specific glue for the generic bulk engine (shopifyBulk.ts): the
// productSet mutation, the ProductSetInput builder, the JSONL line builder
// (buildLines), and the result-line parser (parsePayload). The stateful
// start/reconcile/batch orchestration is added in Phase 3 and lives here too,
// wired directly to the product Prisma models.
//
// The mutation is validated against the 2026-01 Admin schema via the shopify-dev
// MCP. Inside a bulk operation productSet runs synchronously per line — one JSONL
// line per product. productSet userErrors are ProductSetUserError with a REAL
// `code`, so the report groups rejections on (field, code) directly.
export const PRODUCT_SET_MUTATION =
  'mutation call($input: ProductSetInput!) { productSet(input: $input) { product { id } userErrors { code field message } } }';

// Applied to every created product so the whole import is reversible
// (productDelete by tag during teardown). Per-run tag isolates one import's
// products for cleanup across every store a batch touched.
export const TEARDOWN_TAG = 'qa-import';
export function qaImportTagForRun(importRunId: string): string {
  return `qa-import-${importRunId}`;
}

// ── value helpers ─────────────────────────────────────────────────────────────

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

function lastFieldSegment(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  const segments = field.filter((s) => s !== 'input');
  const last = (segments[segments.length - 1] ?? field[field.length - 1]) as string;
  return typeof last === 'string' ? last : null;
}

// ── ProductSetInput building ──────────────────────────────────────────────────

const OPTION_NAME_COLS = ['Option1 Name', 'Option2 Name', 'Option3 Name'];
const OPTION_VALUE_COLS = ['Option1 Value', 'Option2 Value', 'Option3 Value'];

// A row contributes a variant if it carries any variant-distinguishing data.
// (Trailing image-only rows — only Image Src populated — are not variants.)
function hasVariantData(row: Record<string, string>): boolean {
  return (
    col(row, ...OPTION_VALUE_COLS) !== '' ||
    col(row, 'Variant SKU') !== '' ||
    col(row, 'Variant Price') !== ''
  );
}

// The CSV's "Variant Grams" is ALWAYS grams regardless of "Variant Weight Unit"
// (the unit column only sets the display unit), so convert grams into that unit.
const GRAMS_PER_UNIT: Record<string, number> = {
  g: 1,
  kg: 1000,
  lb: 453.59237,
  oz: 28.349523125,
};
const WEIGHT_UNIT_ENUM: Record<string, string> = {
  g: 'GRAMS',
  kg: 'KILOGRAMS',
  lb: 'POUNDS',
  oz: 'OUNCES',
};

function buildWeight(row: Record<string, string>): Record<string, unknown> | null {
  const gramsRaw = col(row, 'Variant Grams');
  const grams = Number(gramsRaw);
  if (gramsRaw === '' || !Number.isFinite(grams)) return null;
  const unitKey = col(row, 'Variant Weight Unit').toLowerCase();
  const unit = WEIGHT_UNIT_ENUM[unitKey] ?? 'GRAMS';
  const value = grams / (GRAMS_PER_UNIT[unitKey] ?? 1);
  return { value: Math.round(value * 10000) / 10000, unit };
}

function buildVariantFields(
  row: Record<string, string>,
  locationId?: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = compact({
    sku: col(row, 'Variant SKU'),
    price: col(row, 'Variant Price'),
    compareAtPrice: col(row, 'Variant Compare At Price'),
    barcode: col(row, 'Variant Barcode'),
  });
  const taxable = col(row, 'Variant Taxable');
  if (taxable !== '') fields.taxable = isTruthy(taxable);
  // Variant image: FileSetInput on the variant. Shopify matches it against the
  // product-level `files` entry with the same originalSource instead of
  // re-uploading, so a URL repeated from Image Src is not duplicated.
  const image = col(row, 'Variant Image');
  if (image !== '') fields.file = { originalSource: image, contentType: 'IMAGE' };

  // "Variant Inventory Policy": deny (default) / continue.
  const policy = col(row, 'Variant Inventory Policy').toLowerCase();
  if (policy !== '') fields.inventoryPolicy = policy === 'continue' ? 'CONTINUE' : 'DENY';

  // InventoryItemInput: tracked ("Variant Inventory Tracker" is blank for
  // untracked; any tracker value means tracked — third-party trackers like
  // shipwire have no API equivalent, tracking is the closest representation),
  // unit cost, requiresShipping, and weight.
  const inventoryItem: Record<string, unknown> = compact({
    cost: col(row, 'Cost per item'),
  });
  const tracker = col(row, 'Variant Inventory Tracker');
  if (tracker !== '') inventoryItem.tracked = true;
  const requiresShipping = col(row, 'Variant Requires Shipping');
  if (requiresShipping !== '') inventoryItem.requiresShipping = isTruthy(requiresShipping);
  const weight = buildWeight(row);
  if (weight) inventoryItem.measurement = { weight };
  if (Object.keys(inventoryItem).length > 0) fields.inventoryItem = inventoryItem;

  // "Variant Inventory Qty" needs a location; when the store's location couldn't
  // be resolved (missing read_locations scope) quantities are skipped rather
  // than failing every product line.
  const qtyRaw = col(row, 'Variant Inventory Qty');
  const qty = Number(qtyRaw);
  if (locationId && qtyRaw !== '' && Number.isInteger(qty)) {
    fields.inventoryQuantities = [{ locationId, name: 'available', quantity: qty }];
  }

  return fields;
}

// A product's images come from every row of its Handle group that has Image Src
// (variant rows and trailing image-only rows alike): ordered by Image Position
// when given, de-duplicated by URL. Shopify fetches each external URL itself
// (FileSetInput.originalSource), so no staged upload is needed for images.
function buildProductFiles(rows: Record<string, string>[]): Record<string, unknown>[] {
  const seen = new Map<string, { alt: string; position: number }>();
  for (const row of rows) {
    const src = col(row, 'Image Src');
    if (src === '' || seen.has(src)) continue;
    const posRaw = col(row, 'Image Position');
    const position = /^\d+$/.test(posRaw) ? Number(posRaw) : Number.MAX_SAFE_INTEGER;
    seen.set(src, { alt: col(row, 'Image Alt Text'), position });
  }
  return [...seen.entries()]
    .sort((a, b) => a[1].position - b[1].position) // stable → ties keep row order
    .map(([src, { alt }]) =>
      compact({ originalSource: src, alt, contentType: 'IMAGE' }),
    );
}

/** Build one ProductSetInput from a Handle group. Product-level fields come from
 *  the group's first row; options are the Option*Name + the distinct values seen
 *  across the group's variant rows; one variant per variant row. */
export function buildProductSetInput(
  group: ProductGroup,
  importRunId: string,
  locationId?: string,
): Record<string, unknown> {
  const rows = group.rows.map((r) => r.normalized);
  const first = rows[0] ?? {};

  // Variant rows: the first row is always the product's first variant; later rows
  // are variants only if they carry variant data (skips trailing image rows).
  const variantRows = rows.filter((row, i) => i === 0 || hasVariantData(row));

  const optionNames = OPTION_NAME_COLS.map((c) => col(first, c)).filter(Boolean);

  let productOptions: Record<string, unknown>[];
  let variants: Record<string, unknown>[];

  if (optionNames.length === 0) {
    // No declared options — Shopify's single default option/variant. optionValues
    // is required on every variant, so synthesize Title / Default Title.
    productOptions = [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }];
    variants = variantRows.map((row) => ({
      optionValues: [{ optionName: 'Title', name: 'Default Title' }],
      ...buildVariantFields(row, locationId),
    }));
  } else {
    // Distinct, non-empty values per option position, in first-seen order.
    const valuesPerOption = optionNames.map((_, i) => {
      const seen = new Set<string>();
      const values: { name: string }[] = [];
      for (const row of variantRows) {
        const v = col(row, OPTION_VALUE_COLS[i]);
        if (v && !seen.has(v)) {
          seen.add(v);
          values.push({ name: v });
        }
      }
      return values;
    });

    productOptions = optionNames.map((name, i) => ({
      name,
      position: i + 1,
      values: valuesPerOption[i],
    }));

    variants = variantRows.map((row) => ({
      optionValues: optionNames.map((name, i) => ({
        optionName: name,
        name: col(row, OPTION_VALUE_COLS[i]),
      })),
      ...buildVariantFields(row, locationId),
    }));
  }

  const csvTags = col(first, 'Tags')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const tags = [TEARDOWN_TAG, qaImportTagForRun(importRunId), ...csvTags];

  // The "Status" column (active/draft/archived, newer templates) wins; only
  // when it's absent does "Published" decide active-vs-draft. (Published really
  // controls Online Store publication, which productSet can't set — a Shopify
  // CSV with Status=active + Published=FALSE means "active but unpublished",
  // and mapping it to DRAFT would be wrong.)
  const statusCol = col(first, 'Status').toLowerCase();
  const published = col(first, 'Published');
  let status: string;
  if (statusCol === 'active' || statusCol === 'draft' || statusCol === 'archived') {
    status = statusCol.toUpperCase();
  } else {
    status = published === '' || isTruthy(published) ? 'ACTIVE' : 'DRAFT';
  }

  const input: Record<string, unknown> = compact({
    handle: group.handle,
    title: col(first, 'Title'),
    descriptionHtml: col(first, 'Body (HTML)', 'Body HTML', 'Body'),
    vendor: col(first, 'Vendor'),
    productType: col(first, 'Type', 'Product Type'),
    tags,
  });
  input.status = status;
  const giftCard = col(first, 'Gift Card');
  if (giftCard !== '') input.giftCard = isTruthy(giftCard);
  input.productOptions = productOptions;
  input.variants = variants;

  const files = buildProductFiles(rows);
  if (files.length > 0) input.files = files;

  // Product-level metafields from the group's first row. We omit `type` and let
  // Shopify resolve it from the existing metafield definition (so the matching
  // definitions must already exist on the store). A metafield value Shopify
  // rejects (e.g. a taxonomy/reference field given plain text) fails the whole
  // productSet line — which is exactly the kind of issue this QA tool surfaces.
  const metafields = extractMetafields(first).map((mf) => ({
    namespace: mf.namespace,
    key: mf.key,
    value: mf.value,
  }));
  if (metafields.length > 0) input.metafields = metafields;

  return input;
}

// ── buildLines / parsePayload for the generic engine ──────────────────────────

/** Build the JSONL bulk payload (one `{"input": ProductSetInput}` line per
 *  product) plus the per-line refs (Handles) the engine maps results back to. */
export function buildProductLines(
  groups: ProductGroup[],
  importRunId: string,
  locationId?: string,
): BuiltJsonl<string> {
  const lines: string[] = [];
  const lineRefs: string[] = [];
  for (const group of groups) {
    const input = buildProductSetInput(group, importRunId, locationId);
    lines.push(JSON.stringify({ input }));
    lineRefs.push(group.handle);
  }
  return { jsonl: lines.join('\n'), lineRefs };
}

/** The store's first active location, for inventoryQuantities. Returns undefined
 *  instead of throwing (e.g. missing read_locations scope) — inventory levels
 *  are then skipped for the run rather than failing every product line. */
async function fetchLocationId(
  client: Awaited<ReturnType<typeof getShopifyClient>>,
): Promise<string | undefined> {
  try {
    const data = await client.query<{ locations: { nodes: { id: string }[] } }>(
      'query { locations(first: 1) { nodes { id } } }',
    );
    return data.locations.nodes[0]?.id;
  } catch (err) {
    console.warn(
      `Could not resolve a location for ${client.shop}; importing without inventory quantities: ${(err as Error).message}`,
    );
    return undefined;
  }
}

/** Parse one productSet result line into a per-product outcome. Uses the real
 *  ProductSetUserError `code` — no synthesis. */
export function parseProductSetLine(
  line: BulkResultLine<string>,
): ProductImportOutcome {
  const handle = line.ref ?? '(unknown)';

  const payload = line.data.productSet as
    | {
        product: { id: string } | null;
        userErrors: { code: string | null; field: unknown; message: string }[];
      }
    | undefined;

  if (!payload) {
    // Top-level error line (e.g. malformed variables) — treat as rejected.
    const message =
      typeof line.raw.message === 'string' ? line.raw.message : 'Unknown bulk error.';
    return {
      handle,
      accepted: false,
      shopifyProductId: null,
      shopifyField: null,
      shopifyCode: null,
      message,
    };
  }

  if (payload.userErrors.length === 0 && payload.product) {
    return {
      handle,
      accepted: true,
      shopifyProductId: payload.product.id,
      shopifyField: null,
      shopifyCode: null,
      message: null,
    };
  }

  const firstErr = payload.userErrors[0];
  return {
    handle,
    accepted: false,
    shopifyProductId: payload.product?.id ?? null,
    shopifyField: lastFieldSegment(firstErr?.field),
    shopifyCode: firstErr?.code ?? null,
    message: firstErr?.message ?? 'Rejected by Shopify.',
  };
}

// ── orchestration (async start → reconcile-on-poll, single + parallel batch) ──
//
// Copied near-verbatim from the customer tool's hardened engine, wired directly
// to the product models (no entity adapter). The import unit is a product
// (Handle group), so batches split over GROUPS, not CSV rows, and results are
// keyed by Handle. Each reconcile advances at most one step; finalization is
// guarded by an updateMany(status:RUNNING) transition so concurrent polls can't
// double-write. The DB is the source of truth, so a run survives a restart.

export type RunProductImportResult =
  | { notFound: true }
  | { ok: false; error: string }
  | { ok: true; importRunId: string };

interface OriginalRowRecord {
  rowNumber: number;
  data: unknown;
}

// Rebuild the Handle groups from the persisted CSV rows. groupByHandle preserves
// first-seen order over the asc-by-rowNumber rows, so the grouping (and thus the
// batch split below) is deterministic across the start and later reconcile calls.
function groupsFromOriginalRows(rows: OriginalRowRecord[]): ProductGroup[] {
  const csvRows: ProductCsvRow[] = rows.map((r) => {
    const data = (r.data ?? {}) as Record<string, string>;
    return { rowNumber: r.rowNumber, original: data, normalized: normalizeRecord(data) };
  });
  return groupByHandle(csvRows);
}

// ── start (fast): single store ───────────────────────────────────────────────

export async function startProductImport(
  uploadId: string,
  storeId?: string,
): Promise<RunProductImportResult> {
  const upload = await prisma.productUploadRun.findUnique({
    where: { id: uploadId },
    include: { originalRows: { orderBy: { rowNumber: 'asc' } } },
  });
  if (!upload) return { notFound: true };

  // Throws ShopifyConfigError (handled by controller) if env is unset.
  const client = await getShopifyClient(storeId);
  const health = await client.verifyConnection();
  if (!health.ok) {
    return { ok: false, error: health.error ?? 'Shopify connection not healthy.' };
  }

  const importRunId = uuidv4();
  const groups = groupsFromOriginalRows(upload.originalRows);
  const locationId = await fetchLocationId(client);
  const { jsonl, lineRefs } = buildProductLines(groups, importRunId, locationId);
  if (lineRefs.length === 0) {
    return { ok: false, error: 'This upload has no products to import.' };
  }

  // ── PRE-PERSIST before the side effect. Same rule as the batch path.
  //
  //    The bulk op creates real products in a real store. Submitting it before the
  //    run row exists means a crash in between leaves the op RUNNING on Shopify
  //    with NO database row at all: the user sees nothing happened, while products
  //    land in the store tagged qa-import-<importRunId> — an id that only ever
  //    existed in memory. Untracked, unreconcilable, and invisible to the
  //    run-scoped cleanup.
  //
  //    Never take a side effect you have not recorded. The row goes down first, as
  //    PENDING; the op id lands on it the moment Shopify hands one back.
  await prisma.productImportRun.create({
    data: {
      id: importRunId,
      uploadId,
      storeId: storeId ?? null,
      shopDomain: health.shop ?? shopDomainFor(storeId ?? ''),
      bulkOperationId: null,
      status: 'PENDING',
      successCount: 0,
      errorCount: 0,
    },
  });

  try {
    await submitSingleStoreRun(importRunId, client, jsonl);
  } catch (err) {
    const message = (err as Error).message;
    await prisma.productImportRun.update({
      where: { id: importRunId },
      data: { status: 'FAILED', error: message },
    });
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
  const stagedPath = await stagedUpload(client, jsonl, 'bulk_products.jsonl');
  const bulkOpId = await runBulkMutation(client, PRODUCT_SET_MUTATION, stagedPath);

  await prisma.productImportRun.update({
    where: { id: importRunId },
    data: { status: 'RUNNING', bulkOperationId: bulkOpId },
  });
}

// ── reconcile (advances at most one step) ────────────────────────────────────

export async function reconcileProductImportRun(
  importRunId: string,
): Promise<ProductImportFeedback | null> {
  const run = await prisma.productImportRun.findUnique({
    where: { id: importRunId },
    include: { batchJobs: true },
  });
  if (!run) return null;
  if (TERMINAL_BULK_STATUSES.includes(run.status)) {
    return getProductImportFeedback(importRunId);
  }

  // A batch parent has no bulk op of its own — advance its children instead.
  if (run.batchJobs.length > 0) {
    return reconcileBatchRun(importRunId, run.batchJobs);
  }
  // Shouldn't happen for a single run, but guard the nullable column.
  if (!run.bulkOperationId) {
    return getProductImportFeedback(importRunId);
  }

  const client = await getShopifyClient(run.storeId ?? undefined);
  const state = await fetchBulkOperationState(client, run.bulkOperationId);

  // Still queued/processing — leave it RUNNING.
  if (!TERMINAL_BULK_STATUSES.includes(state.status)) {
    return getProductImportFeedback(importRunId);
  }

  if (state.status === 'COMPLETED') {
    await finalizeCompletedRun(importRunId, state.url);
  } else {
    const error = `Bulk operation ${state.status}${
      state.errorCode ? ` (${state.errorCode})` : ''
    }.`;
    await prisma.productImportRun.updateMany({
      where: { id: importRunId, status: 'RUNNING' },
      data: { status: state.status, error },
    });
  }

  return getProductImportFeedback(importRunId);
}

// Resume/show the most recent import for an upload — used when reopening a run
// from History. Reconciles so a still-RUNNING import is advanced.
export async function reconcileLatestImportForUpload(
  uploadId: string,
): Promise<ProductImportFeedback | null> {
  const latest = await prisma.productImportRun.findFirst({
    where: { uploadId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!latest) return null;
  return reconcileProductImportRun(latest.id);
}

// Deletes the products created by an import run, across every store it touched.
// A batch spreads its products over all its jobs' stores (all sharing the
// qa-import-<importRunId> tag); a single run uses its own store (or the caller's
// fallback). Results are aggregated into one CleanupResult.
/**
 * Reverse one import: delete everything it created, across every store it touched.
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
  const run = await prisma.productImportRun.findUnique({
    where: { id: importRunId },
    include: { batchJobs: { select: { storeId: true } } },
  });
  const tag = qaImportTagForRun(importRunId);

  const storeIds: (string | undefined)[] =
    run && run.batchJobs.length > 0
      ? [...new Set(run.batchJobs.map((j) => j.storeId ?? undefined))]
      : [run?.storeId ?? fallbackStoreId];

  // Each store is a separate shop, so start them concurrently.
  return startCleanupRuns('PRODUCT', storeIds, tag, importRunId);
}

// Download + parse results and write rowResults, but only if THIS call wins the
// RUNNING → COMPLETED transition (updateMany returns count: 0 if another poll
// already finalized), keeping concurrent reconciles idempotent.
async function finalizeCompletedRun(
  importRunId: string,
  resultUrl: string | null,
): Promise<void> {
  const run = await prisma.productImportRun.findUnique({
    where: { id: importRunId },
    include: {
      uploadRun: { include: { originalRows: { orderBy: { rowNumber: 'asc' } } } },
    },
  });
  if (!run || run.status !== 'RUNNING') return;

  const groups = groupsFromOriginalRows(run.uploadRun.originalRows);
  const lineRefs = groups.map((g) => g.handle);
  const outcomes = resultUrl
    ? await fetchAndParseBulkResults(resultUrl, lineRefs, parseProductSetLine)
    : [];

  const successCount = outcomes.filter((o) => o.accepted).length;
  const errorCount = outcomes.length - successCount;

  await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.productImportRun.updateMany({
        where: { id: importRunId, status: 'RUNNING' },
        data: { status: 'COMPLETED', successCount, errorCount },
      });
      // Another concurrent reconcile already finalized this run — don't double-insert.
      if (claimed.count === 0) return;

      const rows = outcomes.map((o) => ({
        id: uuidv4(),
        importRunId,
        storeId: run.storeId,
        handle: o.handle,
        accepted: o.accepted,
        shopifyProductId: o.shopifyProductId,
        shopifyCode: o.shopifyCode,
        shopifyField: o.shopifyField,
        message: o.message,
      }));

      // Chunk the insert so a single multi-row INSERT doesn't dominate the
      // transaction budget on large runs (same pattern as the customer side).
      const CHUNK = 5000;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.productImportResult.createMany({ data: rows.slice(i, i + CHUNK) });
      }
    },
    // Large runs need far more than the 5s interactive-transaction default.
    { timeout: 120_000, maxWait: 10_000 },
  );
}

// ── parallel batch import across multiple stores ─────────────────────────────

// Splits the upload's PRODUCTS across the selected stores and kicks off one bulk
// op per store in parallel. Returns immediately with a parent ProductImportRun
// id; the per-store jobs are finalized and merged into the parent's rowResults by
// the reconcile poll.
export async function startBatchProductImport(
  uploadId: string,
  storeIds: string[],
): Promise<RunProductImportResult> {
  const upload = await prisma.productUploadRun.findUnique({
    where: { id: uploadId },
    include: { originalRows: { orderBy: { rowNumber: 'asc' } } },
  });
  if (!upload) return { notFound: true };
  if (storeIds.length === 0) return { ok: false, error: 'Select at least one store.' };

  const groups = groupsFromOriginalRows(upload.originalRows);
  if (groups.length === 0) {
    return { ok: false, error: 'This upload has no products to import.' };
  }

  const parentId = uuidv4();
  const batches = splitIntoBatches(groups, storeIds.length);

  // ── 1. PLAN the jobs. No Shopify calls: every field here comes from the CSV
  //       or from env config, so this cannot fail halfway through.
  const planned = storeIds
    .map((storeId, index) => ({
      id: uuidv4(),
      storeId,
      index,
      batch: batches[index] ?? [],
      // The shop domain is in env config, so we do NOT need verifyConnection()
      // to know it. That is what lets the whole plan be persisted before we
      // talk to Shopify at all.
      shopDomain: shopDomainFor(storeId),
    }))
    .filter((p) => p.batch.length > 0); // fewer products than stores

  if (planned.length === 0) {
    return { ok: false, error: 'No products to import.' };
  }

  // ── 2. PRE-PERSIST the parent and EVERY job as PENDING, in ONE transaction,
  //       BEFORE any Shopify call.
  //
  //       This is the whole ballgame. The rollup in reconcileBatchRun asks
  //       `fresh.every(j => TERMINAL.includes(j.status))` over the jobs it finds
  //       in the DB. If jobs are written as they complete, a crash mid-fan-out
  //       leaves 2 of 5 rows on disk, every() sees two terminal jobs, agrees,
  //       and rolls the parent up to COMPLETED — reporting a successful import
  //       of three stores that never received anything.
  //
  //       Writing all N jobs up front as PENDING makes that impossible: PENDING
  //       is not in TERMINAL_BULK_STATUSES, so the unstarted jobs are on disk and
  //       hold the rollup open. A partial fan-out can no longer lie; the worst it
  //       can do is leave the run unfinished, which resumePendingJobs() then
  //       picks up. Pinned by test/integration/batchRollup.test.ts.
  await prisma.productImportRun.create({
    data: {
      id: parentId,
      uploadId,
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
          productCount: p.batch.length,
          successCount: 0,
          errorCount: 0,
        })),
      },
    },
  });

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
 * so it holds the parent's rollup open — and resumePendingJobs() picks it up.
 */
async function launchBatchJob(
  jobId: string,
  storeId: string,
  batch: ProductGroup[],
  parentId: string,
): Promise<void> {
  try {
    const client = await getShopifyClient(storeId);
    const health = await client.verifyConnection();
    if (!health.ok) {
      await prisma.productImportJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error: health.error ?? 'Store not healthy.' },
      });
      return;
    }

    const locationId = await fetchLocationId(client);
    const { jsonl } = buildProductLines(batch, parentId, locationId);
    const stagedPath = await stagedUpload(client, jsonl, 'bulk_products.jsonl');
    const bulkOpId = await runBulkMutation(client, PRODUCT_SET_MUTATION, stagedPath);

    // The gap between runBulkMutation returning and this write landing is the
    // one window where a crash leaves a bulk op running on Shopify that we have
    // no id for. resumePendingJobs() closes it by ADOPTING the shop's
    // currentBulkOperation rather than submitting a second one (Shopify allows
    // only one per shop, so a naive re-submit would just fail).
    await prisma.productImportJob.update({
      where: { id: jobId },
      data: {
        status: 'RUNNING',
        bulkOperationId: bulkOpId,
        shopDomain: health.shop ?? shopDomainFor(storeId),
      },
    });
  } catch (err) {
    await prisma.productImportJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', error: (err as Error).message },
    });
  }
}

// Advances a batch parent: polls each non-terminal job once, merges completed
// ones into the parent's rowResults, and rolls the parent status up when every
// job is terminal (FAILED if any job didn't COMPLETE).
async function reconcileBatchRun(
  parentId: string,
  jobs: ProductImportJob[],
): Promise<ProductImportFeedback | null> {
  for (const job of jobs) {
    if (TERMINAL_BULK_STATUSES.includes(job.status)) continue;
    if (!job.bulkOperationId) continue; // never started → already effectively failed

    // Bound stuck jobs: count this poll and fail the job once it's been checked
    // too many times without reaching a terminal state.
    const attempts = job.pollAttempts + 1;
    if (attempts > MAX_JOB_POLL_ATTEMPTS) {
      await prisma.productImportJob.updateMany({
        where: { id: job.id, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          error: `Timed out: still running after ${MAX_JOB_POLL_ATTEMPTS} status checks.`,
        },
      });
      continue;
    }
    await prisma.productImportJob.update({
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
        await prisma.productImportJob.updateMany({
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
        await prisma.productImportJob.updateMany({
          where: { id: job.id, status: 'RUNNING' },
          data: { status: 'FAILED', error: (err as Error).message },
        });
      }
    }
  }

  // Roll up: re-read jobs and recompute parent counts from the merged rowResults.
  const fresh = await prisma.productImportJob.findMany({ where: { importRunId: parentId } });
  const allTerminal = fresh.every((j) => TERMINAL_BULK_STATUSES.includes(j.status));
  const merged = await prisma.productImportResult.findMany({
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
    await prisma.productImportRun.updateMany({
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
    await prisma.productImportRun.updateMany({
      where: { id: parentId, status: 'RUNNING' },
      data: { successCount, errorCount },
    });
  }

  return getProductImportFeedback(parentId);
}

// Parses one completed job's results and merges them into the parent's
// rowResults — guarded by the job's RUNNING → COMPLETED transition so concurrent
// polls insert exactly once.
async function finalizeCompletedJob(
  parentId: string,
  job: ProductImportJob,
  resultUrl: string | null,
): Promise<void> {
  const parent = await prisma.productImportRun.findUnique({
    where: { id: parentId },
    include: {
      uploadRun: { include: { originalRows: { orderBy: { rowNumber: 'asc' } } } },
    },
  });
  if (!parent) return;

  // Same split as startBatchProductImport → this job's exact product slice → refs.
  const groups = groupsFromOriginalRows(parent.uploadRun.originalRows);
  const slice = splitIntoBatches(groups, job.batchCount)[job.batchIndex] ?? [];
  const lineRefs = slice.map((g) => g.handle);
  const outcomes = resultUrl
    ? await fetchAndParseBulkResults(resultUrl, lineRefs, parseProductSetLine)
    : [];

  const successCount = outcomes.filter((o) => o.accepted).length;
  const errorCount = outcomes.length - successCount;

  await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.productImportJob.updateMany({
        where: { id: job.id, status: 'RUNNING' },
        data: { status: 'COMPLETED', successCount, errorCount },
      });
      if (claimed.count === 0) return; // another poll already merged this job

      const rows = outcomes.map((o) => ({
        id: uuidv4(),
        importRunId: parentId,
        storeId: job.storeId,
        handle: o.handle,
        accepted: o.accepted,
        shopifyProductId: o.shopifyProductId,
        shopifyCode: o.shopifyCode,
        shopifyField: o.shopifyField,
        message: o.message,
      }));

      // Chunk the insert so a single multi-row INSERT doesn't dominate the
      // transaction budget on large runs (same pattern as the customer side).
      const CHUNK = 5000;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.productImportResult.createMany({ data: rows.slice(i, i + CHUNK) });
      }
    },
    // Large runs need far more than the 5s interactive-transaction default.
    { timeout: 120_000, maxWait: 10_000 },
  );
}

// ── crash recovery (resume-on-boot) ──────────────────────────────────────────
//
// A PENDING row means "we wrote the row but have no bulk op id for it" — the
// process died between the two. importResume decides, per row, whether the op was
// actually submitted (adopt it) or never reached Shopify (relaunch it). These two
// stores hand it the product-flow plumbing; shopifyImport exports the customer
// twins.

/**
 * Relaunch a batch job whose op never reached Shopify.
 *
 * The slice is NOT stored — it is recomputed from (batchIndex, batchCount) via
 * splitIntoBatches, which is deterministic over the same asc-ordered products.
 * That determinism (pinned by test/shopifyBulk.test.ts) is exactly what makes
 * resume possible without persisting every job's product list.
 */
async function relaunchProductJob(jobId: string): Promise<void> {
  const job = await prisma.productImportJob.findUnique({
    where: { id: jobId },
    include: { importRun: { include: { uploadRun: { include: { originalRows: { orderBy: { rowNumber: 'asc' } } } } } } },
  });
  if (!job) return;
  if (!job.storeId) {
    await prisma.productImportJob.updateMany({
      where: { id: jobId, status: 'PENDING' },
      data: { status: 'FAILED', error: 'Cannot resume: job has no store.' },
    });
    return;
  }

  const groups = groupsFromOriginalRows(job.importRun.uploadRun.originalRows);
  const batch = splitIntoBatches(groups, job.batchCount)[job.batchIndex] ?? [];
  if (batch.length === 0) {
    await prisma.productImportJob.updateMany({
      where: { id: jobId, status: 'PENDING' },
      data: { status: 'FAILED', error: 'Cannot resume: no products in this batch slice.' },
    });
    return;
  }

  // Same path as the original launch — no second implementation to drift.
  await launchBatchJob(jobId, job.storeId, batch, job.importRunId);
}

/** Relaunch a single-store run whose op never reached Shopify. */
async function relaunchProductRun(runId: string): Promise<void> {
  const run = await prisma.productImportRun.findUnique({
    where: { id: runId },
    include: { uploadRun: { include: { originalRows: { orderBy: { rowNumber: 'asc' } } } } },
  });
  if (!run) return;

  const client = await getShopifyClient(run.storeId ?? undefined);
  const groups = groupsFromOriginalRows(run.uploadRun.originalRows);
  const locationId = await fetchLocationId(client);
  const { jsonl, lineRefs } = buildProductLines(groups, runId, locationId);
  if (lineRefs.length === 0) {
    await prisma.productImportRun.updateMany({
      where: { id: runId, status: 'PENDING' },
      data: { status: 'FAILED', error: 'Cannot resume: this upload has no products to import.' },
    });
    return;
  }

  await submitSingleStoreRun(runId, client, jsonl);
}

export function productResumableStores(): ResumableStore[] {
  return [
    {
      label: 'product-run',
      findResumable: (staleBefore) => findResumableRows(prisma.productImportRun as never, staleBefore),
      claim: (id, staleBefore) => claimRow(prisma.productImportRun as never, id, staleBefore),
      adopt: (id, bulkOperationId) => adoptRow(prisma.productImportRun as never, id, bulkOperationId),
      relaunch: relaunchProductRun,
      fail: (id, error) => failRow(prisma.productImportRun as never, id, error),
    },
    {
      label: 'product-job',
      findResumable: (staleBefore) => findResumableRows(prisma.productImportJob as never, staleBefore),
      claim: (id, staleBefore) => claimRow(prisma.productImportJob as never, id, staleBefore),
      adopt: (id, bulkOperationId) => adoptRow(prisma.productImportJob as never, id, bulkOperationId),
      relaunch: relaunchProductJob,
      fail: (id, error) => failRow(prisma.productImportJob as never, id, error),
    },
  ];
}
