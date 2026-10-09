import { v4 as uuidv4 } from 'uuid';
import type { CleanupRun, ProductImportJob } from '@prisma/client';
import prisma from '../db/prisma';
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
import {
  advanceImportOp,
  AMBIGUOUS_SUBMIT_MESSAGE,
  isAmbiguousSubmitError,
} from './importReconcile';
import { col, extractMetafields, groupByHandle } from './productCsvParser';
import {
  hasOptionGap,
  isTruthy,
  OPTION_VALUE_COLS,
  productOptionNames,
  variantOptionValues,
  variantRowIndexes,
} from './productVariants';
import {
  formatMoney,
  parseGrams,
  parseInventoryPolicy,
  parseMoney,
  parseQuantity,
  parseStatus,
  splitTags,
} from './productValues';
import { getShopifyClient } from './shopifyClient';
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

// Every created product carries QA_IMPORT_TAG so the whole import is reversible
// (productDelete by tag during teardown), plus qaImportTagForRun, which isolates
// one import's products for cleanup across every store a batch touched. Both come
// from the cleanup module, as on the customer side: the tag written here and the
// tag cleanup deletes by must be one definition, not copies that can drift.

// Rows written per createMany inside a result-merge transaction, and that
// transaction's budget — a large run's results far outlast the 5s default.
const INSERT_CHUNK = 5000;
const RESULT_TX_OPTIONS = { timeout: 120_000, maxWait: 10_000 };

// ── value helpers ─────────────────────────────────────────────────────────────

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
// Option/variant row logic lives in productVariants.ts, shared with the pre-check.

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

// Grams are read like the admin import reads them (parseGrams: "100g" is 100).
// A value the admin rejects ("heavy") is sent as-is so productSet rejects the
// product too, instead of the import quietly dropping the weight.
function buildWeight(row: Record<string, string>): Record<string, unknown> | null {
  const gramsRaw = col(row, 'Variant Grams');
  const grams = parseGrams(gramsRaw);
  if (grams === null) return null;
  const unitKey = col(row, 'Variant Weight Unit').toLowerCase();
  const unit = WEIGHT_UNIT_ENUM[unitKey] ?? 'GRAMS';
  if (grams === 'invalid') return { value: gramsRaw, unit };
  const value = grams / (GRAMS_PER_UNIT[unitKey] ?? 1);
  return { value: Math.round(value * 10000) / 10000, unit };
}

// Money as the admin import reads it (parseMoney: "$10.00" is 10.00). A cell
// with no number makes the admin refuse the whole file; here it is passed
// through unchanged so productSet rejects just this product and the rest of the
// file still imports.
function money(raw: string): string {
  const value = parseMoney(raw);
  if (value === null) return '';
  return value === 'invalid' ? raw : formatMoney(value);
}

function buildVariantFields(
  row: Record<string, string>,
  locationId?: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = compact({
    sku: col(row, 'Variant SKU'),
    price: money(col(row, 'Variant Price')),
    compareAtPrice: money(col(row, 'Variant Compare At Price')),
    barcode: col(row, 'Variant Barcode'),
  });
  const taxable = col(row, 'Variant Taxable');
  if (taxable !== '') fields.taxable = isTruthy(taxable);
  // Variant image: FileSetInput on the variant. Shopify matches it against the
  // product-level `files` entry with the same originalSource instead of
  // re-uploading; buildProductFiles guarantees that entry exists.
  const image = col(row, 'Variant Image');
  if (image !== '') fields.file = { originalSource: image, contentType: 'IMAGE' };

  // "Variant Inventory Policy": deny / continue in any case; no column at all
  // leaves Shopify's default (deny). An invalid value, or a blank one when the
  // column exists (the admin import refuses the whole file for that), is sent
  // as-is so productSet rejects this product and the report lists it; the rest
  // of the file still imports.
  const policyRaw = col(row, 'Variant Inventory Policy');
  const policy = parseInventoryPolicy(policyRaw);
  if (policy === 'DENY' || policy === 'CONTINUE') fields.inventoryPolicy = policy;
  else if (policy === 'invalid' || 'Variant Inventory Policy' in row) {
    fields.inventoryPolicy = policyRaw.toUpperCase();
  }

  // InventoryItemInput: tracked ("Variant Inventory Tracker" is blank for
  // untracked; any tracker value means tracked — third-party trackers like
  // shipwire have no API equivalent, tracking is the closest representation),
  // unit cost, requiresShipping, and weight.
  const inventoryItem: Record<string, unknown> = compact({
    cost: money(col(row, 'Cost per item')),
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
  // than failing every product line. Read as a leading integer, like the admin
  // import ("1.5" is 1, "ten" is 0): a quantity never fails a product.
  const qty = parseQuantity(col(row, 'Variant Inventory Qty'));
  if (locationId && qty !== null) {
    fields.inventoryQuantities = [{ locationId, name: 'available', quantity: qty }];
  }

  return fields;
}

// A product's images come from every row of its Handle group that has Image Src
// (variant rows and trailing image-only rows alike): ordered by Image Position
// when given, de-duplicated by URL. Shopify fetches each external URL itself
// (FileSetInput.originalSource), so no staged upload is needed for images.
//
// Every Variant Image URL must ALSO be a product file: productSet rejects a variant
// `file` with no matching `files` entry ("File original source missing from the
// product files input"). Shopify's own CSV import has no such rule — Variant Image
// alone adds a variant image — so variant-only URLs are appended after the Image
// Src images. Before this, 37 products in one real migration file were rejected for it.
export function buildProductFiles(rows: Record<string, string>[]): Record<string, unknown>[] {
  const seen = new Map<string, { alt: string; position: number }>();
  for (const row of rows) {
    const src = col(row, 'Image Src');
    if (src === '' || seen.has(src)) continue;
    const posRaw = col(row, 'Image Position');
    const position = /^\d+$/.test(posRaw) ? Number(posRaw) : Number.MAX_SAFE_INTEGER;
    seen.set(src, { alt: col(row, 'Image Alt Text'), position });
  }
  const files = [...seen.entries()]
    .sort((a, b) => a[1].position - b[1].position) // stable → ties keep row order
    .map(([src, { alt }]) =>
      compact({ originalSource: src, alt, contentType: 'IMAGE' }),
    );
  for (const row of rows) {
    const src = col(row, 'Variant Image');
    if (src === '' || seen.has(src)) continue;
    seen.set(src, { alt: '', position: Number.MAX_SAFE_INTEGER });
    files.push({ originalSource: src, contentType: 'IMAGE' });
  }
  return files;
}

/** Build one ProductSetInput from a Handle group. Product-level fields come from
 *  the group's first row; options are the Option*Name + the distinct values seen
 *  across the group's variant rows; one variant per variant row. */
export function buildProductSetInput(
  group: ProductGroup,
  importRunId: string,
  locationId?: string,
  definedMetafields?: Set<string>,
): Record<string, unknown> {
  const rows = group.rows.map((r) => r.normalized);
  const first = rows[0] ?? {};

  // Variant rows: the first row is always the product's first variant; later rows
  // are variants only if they carry variant data (skips trailing image rows).
  const variantRows = variantRowIndexes(rows).map((i) => rows[i]);

  const optionNames = productOptionNames(first);

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
    // Distinct values per option position, in first-seen order. A blank value
    // is "Default Title", as the admin import fills it in (variantOptionValues).
    // Except across a gap (Option3 with no Option2), which the admin rejects:
    // productOptionNames closes the gap, so the shifted option reads the blank
    // column; leaving it with no values makes productSet reject the product too
    // (OPTION_VALUES_MISSING) instead of importing it as "Default Title".
    const gap = hasOptionGap(first);
    const valuesPerOption = optionNames.map((_, i) => {
      const seen = new Set<string>();
      const values: { name: string }[] = [];
      for (const row of variantRows) {
        const v = gap ? col(row, OPTION_VALUE_COLS[i]) : variantOptionValues(row, optionNames)[i];
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
      optionValues: variantOptionValues(row, optionNames).map((value, i) => ({
        optionName: optionNames[i],
        name: value,
      })),
      ...buildVariantFields(row, locationId),
    }));
  }

  const tags = [QA_IMPORT_TAG, qaImportTagForRun(importRunId), ...splitTags(col(first, 'Tags'))];

  // The "Status" column (active/draft/archived/unlisted, newer templates) wins;
  // only when it's blank does "Published" decide active-vs-draft. (Published
  // really controls Online Store publication, which productSet can't set — a
  // Shopify CSV with Status=active + Published=FALSE means "active but
  // unpublished", and mapping it to DRAFT would be wrong.) A Status the admin
  // import rejects is sent as-is so productSet rejects the product too.
  const statusRaw = col(first, 'Status');
  const parsedStatus = parseStatus(statusRaw);
  const published = col(first, 'Published');
  let status: string;
  if (parsedStatus === 'invalid') {
    status = statusRaw.toUpperCase();
  } else if (parsedStatus !== null) {
    status = parsedStatus;
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
  // Shopify resolve it from the existing metafield definition. A metafield
  // column with NO definition on the store is dropped: the admin CSV import
  // skips it silently and imports the product, while productSet would reject
  // the product ("Type can't be blank"). `definedMetafields` is the store's
  // "namespace.key" set; undefined (couldn't be read) sends every metafield.
  // A value Shopify rejects for a DEFINED metafield (e.g. a taxonomy/reference
  // field given plain text) still fails the whole productSet line.
  const metafields = extractMetafields(first)
    .filter((mf) => !definedMetafields || definedMetafields.has(`${mf.namespace}.${mf.key}`))
    .map((mf) => ({
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
  definedMetafields?: Set<string>,
): BuiltJsonl<string> {
  const lines: string[] = [];
  const lineRefs: string[] = [];
  for (const group of groups) {
    const input = buildProductSetInput(group, importRunId, locationId, definedMetafields);
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

/** The store's product metafield definitions as "namespace.key". Returns
 *  undefined instead of throwing — every metafield is then sent, and a column
 *  with no definition rejects its product as it did before. */
async function fetchDefinedMetafields(
  client: Awaited<ReturnType<typeof getShopifyClient>>,
): Promise<Set<string> | undefined> {
  const defined = new Set<string>();
  let after: string | null = null;
  try {
    for (;;) {
      const data: {
        metafieldDefinitions: {
          nodes: { namespace: string; key: string }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } = await client.query(
        `query($after: String) {
          metafieldDefinitions(first: 250, ownerType: PRODUCT, after: $after) {
            nodes { namespace key }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { after },
      );
      for (const d of data.metafieldDefinitions.nodes) defined.add(`${d.namespace}.${d.key}`);
      if (!data.metafieldDefinitions.pageInfo.hasNextPage) return defined;
      after = data.metafieldDefinitions.pageInfo.endCursor;
    }
  } catch (err) {
    console.warn(
      `Could not read metafield definitions for ${client.shop}; sending every metafield: ${(err as Error).message}`,
    );
    return undefined;
  }
}

/** What the builder needs to know about the target store. */
type StoreContext = { locationId?: string; definedMetafields?: Set<string> };

async function fetchStoreContext(
  client: Awaited<ReturnType<typeof getShopifyClient>>,
): Promise<StoreContext> {
  const [locationId, definedMetafields] = await Promise.all([
    fetchLocationId(client),
    fetchDefinedMetafields(client),
  ]);
  return { locationId, definedMetafields };
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
    // Top-level error line (e.g. malformed variables) — treat as rejected. Shopify
    // writes the reason as `message` or as `errors: [{ message }]`.
    const message = bulkLineErrorMessage(line.raw, 'Unknown bulk error.');
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
  // `busy` = a store is already in use (the busy-lock refused). Distinct from a
  // plain error because it is not a failure: it is a 409 the user can retry.
  | { ok: false; error: string; busy?: boolean }
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

// Start a product import into ONE store. It is a one-store batch: same planner,
// same pre-persist, same k-ops-per-store split as a parallel import, so the store's
// share runs as up to BULK_OPS_PER_STORE concurrent bulk ops instead of one. The
// result is a batch parent + jobs, finalized later by reconcileProductImportRun
// (driven by the GET poll), so no HTTP request is held open while Shopify works.
//
// What it keeps from the old single-run path is its front door: the store's health
// is checked first, and an unhealthy store is reported here with Shopify's own
// message rather than as a job that failed. A launch failure after that (a refused
// or ambiguous submit) lands on the job and reaches the user through the poll, as
// for any batch. The old single-run submit (submitSingleStoreRun) is no longer
// reached for new runs; it and the single-run reconcile stay so runs written
// before this change still drain. Customer twin: startCustomerImport.
export async function startProductImport(
  uploadId: string,
  storeId: string,
): Promise<RunProductImportResult> {
  // Existence only: startBatchProductImport loads the rows, and a large upload's
  // rows are not worth reading twice.
  const upload = await prisma.productUploadRun.findUnique({
    where: { id: uploadId },
    select: { id: true },
  });
  if (!upload) return { notFound: true };

  // Throws ShopifyConfigError (handled by controller) if env is unset.
  const client = await getShopifyClient(storeId);
  const health = await client.verifyConnection();
  if (!health.ok) {
    return { ok: false, error: health.error ?? 'Shopify connection not healthy.' };
  }

  return startBatchProductImport(uploadId, [storeId]);
}

/**
 * Submit a pre-persisted single-store run's bulk op and record its id.
 *
 * Only resume-on-boot reaches this now: new single-store imports are one-store
 * batches (see startProductImport). It stays for a single run written before that
 * change and left PENDING across the deploy.
 */
async function submitSingleStoreRun(
  importRunId: string,
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  jsonl: string,
): Promise<void> {
  // Queue the op (seconds-scale); do NOT wait for it to finish here.
  const stagedPath = await stagedUpload(client, jsonl, 'bulk_products.jsonl');
  // Intent before the side effect — see decideResume in importResume.service.ts.
  await markSubmitAttempt(prisma.productImportRun as never, importRunId);
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

  // Same per-op handling as a batch job (errors isolated, permanent failures fail
  // the run and free its store, a colleague's run left alone). See the customer
  // twin and advanceImportOp.
  await advanceImportOp({
    label: `product run ${importRunId}`,
    storeId: run.storeId,
    bulkOperationId: run.bulkOperationId,
    startedAt: run.submitAttemptedAt ?? run.createdAt,
    onCompleted: (state) => finalizeRun(importRunId, 'COMPLETED', null, state.url, { kind: 'complete' }),
    onEnded: (state, error) => finalizeEndedRun(importRunId, state, error),
    onFailed: async (error) => {
      await prisma.productImportRun.updateMany({
        where: { id: importRunId, status: 'RUNNING' },
        data: { status: 'FAILED', error },
      });
    },
    renewLock: () => renewStoreLock(importRunId),
    releaseLock: () => releaseStoreLock(importRunId),
  });

  return getProductImportFeedback(importRunId);
}

/**
 * Record an op that ended FAILED / CANCELED / EXPIRED together with whatever it
 * created before stopping (partialDataUrl), so the report shows what is actually
 * in the store. Best-effort, status and error kept — see the customer twin,
 * finalizeEndedRun in shopifyImport.service.ts.
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
    await prisma.productImportRun.updateMany({
      where: { id: importRunId, status: 'RUNNING' },
      data: { status: state.status, error },
    });
  }
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

/**
 * The upload's product Handles in import order — exactly the lineRefs
 * buildProductLines produced, since groupByHandle opens one group per distinct
 * trimmed Handle in row order (a blank Handle continues the previous group and
 * never opens one).
 *
 * Exported for the test that pins it to groupByHandle.
 */
export function handlesInOrder(handles: (string | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of handles) {
    const handle = (raw ?? '').trim();
    if (handle === '' || seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

/**
 * Read only the Handle column of an upload, in row order. Mapping results back
 * needs nothing else, and loading every row's full JSON — a large upload is
 * hundreds of thousands of rows — just to read one field from each was the
 * finalize step's whole memory cost.
 */
async function uploadHandles(uploadId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ handle: string | null }[]>`
    SELECT data->>'Handle' AS handle
    FROM product_original_rows
    WHERE "uploadRunId" = ${uploadId}
    ORDER BY "rowNumber" ASC`;
  return handlesInOrder(rows.map((r) => r.handle));
}

// Download + parse results and write rowResults, but only if THIS call wins the
// RUNNING → terminal transition (updateMany returns count: 0 if another poll
// already finalized), keeping concurrent reconciles idempotent. `status` is
// COMPLETED, or the op's own FAILED / CANCELED / EXPIRED for partial results.
async function finalizeRun(
  importRunId: string,
  status: string,
  error: string | null,
  resultUrl: string | null,
  source: BulkResultSource,
): Promise<void> {
  const run = await prisma.productImportRun.findUnique({ where: { id: importRunId } });
  if (!run || run.status !== 'RUNNING') return;

  const lineRefs = await uploadHandles(run.uploadId);
  const outcomes = resultUrl
    ? await fetchAndParseBulkResults(resultUrl, lineRefs, source, parseProductSetLine)
    : [];

  await writeProductResults(
    outcomes,
    { importRunId, storeId: run.storeId },
    (tx, successCount, errorCount) =>
      tx.productImportRun.updateMany({
        where: { id: importRunId, status: 'RUNNING' },
        data: { status, error, successCount, errorCount },
      }),
  );
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Write one op's outcomes, in the transaction that claims its run/job's RUNNING →
 * terminal transition (count 0 = a concurrent poll already did, insert nothing).
 * Chunked, with the long budget. Customer twin: writeRowResults.
 */
async function writeProductResults(
  outcomes: ProductImportOutcome[],
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
      handle: o.handle,
      accepted: o.accepted,
      shopifyProductId: o.shopifyProductId,
      shopifyCode: o.shopifyCode,
      shopifyField: o.shopifyField,
      message: o.message,
    }));

    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.productImportResult.createMany({ data: rows.slice(i, i + INSERT_CHUNK) });
    }
  }, RESULT_TX_OPTIONS);
}

// ── parallel batch import across multiple stores ─────────────────────────────

// Splits the upload's PRODUCTS across the selected stores, and each store's share
// across k concurrent bulk ops, and kicks them all off in parallel. Returns
// immediately with a parent ProductImportRun id; the jobs are finalized and merged
// into the parent's rowResults by the reconcile poll. A single-store import is this
// with one store. Customer twin: startBatchImport.
export async function startBatchProductImport(
  uploadId: string,
  storeIds: string[],
): Promise<RunProductImportResult> {
  const upload = await prisma.productUploadRun.findUnique({
    where: { id: uploadId },
    include: { originalRows: { orderBy: { rowNumber: 'asc' } } },
  });
  if (!upload) return { notFound: true };
  // One share per store — see the customer twin: a repeated id would plan two shares
  // of the same shop, each sized as if it had the shop's bulk-op slots to itself,
  // under ONE lock (acquireStoreLocks dedupes).
  storeIds = [...new Set(storeIds)];
  if (storeIds.length === 0) return { ok: false, error: 'Select at least one store.' };

  const groups = groupsFromOriginalRows(upload.originalRows);
  if (groups.length === 0) {
    return {
      ok: false,
      // See the customer twin — a purged upload is retention, not an empty file.
      error: upload.piiPurgedAt ? purgedMessage(upload.piiPurgedAt) : 'This upload has no products to import.',
    };
  }

  const parentId = uuidv4();

  // ── 1. SIZE each store's share: k bulk ops per store, k the SAME for every
  //       store. finalizeJob and resume recompute a job's products from nothing
  //       but (batchIndex, batchCount) over one flat split, so the stores × k
  //       slices must be one splitIntoBatches call — which only stays balanced per
  //       store if every store has the same k. The minimum is the one every store
  //       can take. The unit is the PRODUCT (a whole Handle group, one JSONL line),
  //       never a CSV row: finalizeJob splits the upload's Handle list by the same
  //       count, and a group cut in two would be two half-products.
  //
  //       Read-only Shopify calls (counting ops already running on each shop, and
  //       the store context the builder needs — fetched ONCE per store here rather
  //       than once per job), and best effort: a store we cannot build a client
  //       for is sized without that count, and its launch below records the real
  //       failure on its jobs.
  const perStore = Math.ceil(groups.length / storeIds.length);
  const clients = await Promise.all(
    storeIds.map((storeId) => getShopifyClient(storeId).catch(() => null)),
  );
  const [opCounts, contexts] = await Promise.all([
    Promise.all(
      clients.map((client) => (client ? opsForStoreOnShop(client, perStore) : opsForStore(perStore))),
    ),
    Promise.all(clients.map((client) => (client ? fetchStoreContext(client) : undefined))),
  ]);
  const minOps = Math.min(...opCounts);
  // Cap k so every selected store gets work: with fewer products than stores × k the
  // flat split leaves the trailing slices empty, and those are whole stores idle
  // (lock taken for nothing, absent from the parent shopDomain). With fewer products
  // than stores some store goes without whatever k is, so k stays 1 there.
  const k = Math.max(1, Math.min(minOps, Math.floor(groups.length / storeIds.length)));
  const batchCount = storeIds.length * k;
  const batches = splitIntoBatches(groups, batchCount);

  // ── 2. PLAN the jobs: slice i → store i mod stores (round-robin), so each store
  //       gets k slices. Not k contiguous slices per store: splitIntoBatches gives
  //       its +1 remainders to the EARLIEST slices, and dealt in blocks of k they
  //       all land on the first store(s) — off by up to k-1 products from the
  //       per-store plan the client previews (batchSizeFor). Dealt round-robin,
  //       store j's total is exactly splitIntoBatches(n, stores)[j]. Finalize and
  //       resume index by batchIndex alone, so nothing needs a store's products
  //       contiguous. No side effect yet: every field comes from the CSV, env
  //       config, or the clients built above.
  const domainOf = new Map(
    storeIds.map((storeId, s) => [storeId, clients[s]?.shop ?? shopDomainFor(storeId)]),
  );
  const contextOf = new Map(storeIds.map((storeId, s) => [storeId, contexts[s]]));
  const planned = batches
    .map((batch, index) => {
      const storeId = storeIds[index % storeIds.length];
      return { id: uuidv4(), storeId, index, batch, shopDomain: domainOf.get(storeId)! };
    })
    .filter((p) => p.batch.length > 0); // fewer products than slices

  if (planned.length === 0) {
    return { ok: false, error: 'No products to import.' };
  }
  const plannedStores = [...new Set(planned.map((p) => p.storeId))];

  // ── 3. PRE-PERSIST the parent and EVERY job as PENDING, in ONE transaction,
  //       BEFORE any Shopify side effect.
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
  //
  //       Every store's busy-lock is taken in the SAME transaction, ALL OR NOTHING.
  //       Fanning out to the free stores and failing the busy one would be a partial
  //       fan-out — precisely the half-done, half-reported work the PENDING
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
        ownerType: 'PRODUCT_IMPORT_STORE_SHARE',
        ownerId: shareOwner(parentId, storeId),
        operation: 'a product import',
      }));
      await tx.productImportRun.create({
        data: {
          id: parentId,
          uploadId,
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
              productCount: p.batch.length,
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
  await Promise.all(
    planned.map((p) => launchBatchJob(p.id, p.storeId, p.batch, parentId, contextOf.get(p.storeId))),
  );

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
 *
 * `context` is the store's builder context, fetched once per store by the planner
 * and shared by that store's k jobs; resume passes none and the job fetches its own.
 *
 * Mirrors launchBatchJob in shopifyImport.service.ts.
 */
async function launchBatchJob(
  jobId: string,
  storeId: string,
  batch: ProductGroup[],
  parentId: string,
  context?: StoreContext,
): Promise<void> {
  // Set the moment Shopify hands back an op id. A throw after that is NOT a refused
  // submit — the op exists and may be running — so the catch must not treat it as
  // one (see below).
  let bulkOpId: string | null = null;
  try {
    const client = await getShopifyClient(storeId);
    const health = await client.verifyConnection();
    if (!health.ok) {
      await prisma.productImportJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error: health.error ?? 'Store not healthy.' },
      });
      // This job is terminal (and that write is committed) — free its store if it
      // was the last of its share.
      await releaseJobStore(jobId, parentId, storeId);
      return;
    }

    const { locationId, definedMetafields } = context ?? (await fetchStoreContext(client));
    const { jsonl } = buildProductLines(batch, parentId, locationId, definedMetafields);
    const stagedPath = await stagedUpload(client, jsonl, 'bulk_products.jsonl');
    // Intent before the side effect. From here until the update below lands, a
    // crash leaves an op on Shopify that we may have no id for — and the shop cannot
    // tell us which op is ours. Resume-on-boot sees submitAttemptedAt and fails the
    // job honestly instead of guessing (see decideResume in importResume.service.ts).
    await markSubmitAttempt(prisma.productImportJob as never, jobId);
    bulkOpId = await runBulkMutation(client, PRODUCT_SET_MUTATION, stagedPath);

    await prisma.productImportJob.update({
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
        `[import] product job ${jobId}: bulk op ${bulkOpId} submitted but not recorded:`,
        (err as Error).message,
      );
      await recordAmbiguousSubmit(
        prisma.productImportJob as never,
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
        prisma.productImportJob as never,
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
    await prisma.productImportJob.update({
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
 * it matches nothing. Customer twin: releaseJobStore in shopifyImport.service.ts.
 */
async function releaseJobStore(jobId: string, parentId: string, storeId: string | null): Promise<void> {
  if (storeId) await releaseShareIfDone('product', parentId, storeId);
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
  jobs: ProductImportJob[],
): Promise<ProductImportFeedback | null> {
  for (const job of jobs) {
    if (TERMINAL_BULK_STATUSES.includes(job.status)) continue;
    if (!job.bulkOperationId) continue; // never started → already effectively failed

    // Each job advanced on its own: errors isolated, a colleague's store skipped
    // (never failed), stuck jobs bounded by time since submit and never failed
    // while Shopify still reports them RUNNING. See the customer twin and
    // advanceImportOp. (pollAttempts is no longer read or written here.)
    await advanceImportOp({
      label: `product job ${job.id}`,
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
          await prisma.productImportJob.updateMany({
            where: { id: job.id, status: 'RUNNING' },
            data: { status: state.status, error },
          });
        }
      },
      onFailed: async (error) => {
        await prisma.productImportJob.updateMany({
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
  // counted in the database, not by loading every result row per poll.
  const fresh = await prisma.productImportJob.findMany({
    where: { importRunId: parentId },
    orderBy: { batchIndex: 'asc' },
  });
  const allTerminal = fresh.every((j) => TERMINAL_BULK_STATUSES.includes(j.status));
  const [successCount, totalCount] = await Promise.all([
    prisma.productImportResult.count({ where: { importRunId: parentId, accepted: true } }),
    prisma.productImportResult.count({ where: { importRunId: parentId } }),
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

// Parses one finished job's results (complete, or partial for an op that ended
// FAILED / CANCELED / EXPIRED) and merges them into the parent's rowResults —
// guarded by the job's RUNNING → terminal transition so concurrent polls insert
// exactly once.
async function finalizeJob(
  parentId: string,
  job: ProductImportJob,
  status: string,
  error: string | null,
  resultUrl: string | null,
  source: BulkResultSource,
): Promise<void> {
  const parent = await prisma.productImportRun.findUnique({ where: { id: parentId } });
  if (!parent) return;

  // Same split as startBatchProductImport → this job's exact product slice → refs.
  // splitIntoBatches only counts, so splitting the Handles splits like the groups.
  const handles = await uploadHandles(parent.uploadId);
  const lineRefs = splitIntoBatches(handles, job.batchCount)[job.batchIndex] ?? [];
  const outcomes = resultUrl
    ? await fetchAndParseBulkResults(resultUrl, lineRefs, source, parseProductSetLine)
    : [];

  await writeProductResults(
    outcomes,
    { importRunId: parentId, storeId: job.storeId },
    (tx, successCount, errorCount) =>
      tx.productImportJob.updateMany({
        where: { id: job.id, status: 'RUNNING' },
        data: { status, error, successCount, errorCount },
      }),
  );
}

// ── crash recovery (resume-on-boot) ──────────────────────────────────────────
//
// A PENDING row means "we wrote the row but have no bulk op id for it" — the
// process died between the two. importResume decides, per row, from
// submitAttemptedAt alone: never attempted (relaunch it) or submit outcome unknown
// (fail it, never guess). These two
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
  const { locationId, definedMetafields } = await fetchStoreContext(client);
  const { jsonl, lineRefs } = buildProductLines(groups, runId, locationId, definedMetafields);
  if (lineRefs.length === 0) {
    await prisma.productImportRun.updateMany({
      where: { id: runId, status: 'PENDING' },
      data: { status: 'FAILED', error: 'Cannot resume: this upload has no products to import.' },
    });
    return;
  }

  try {
    await submitSingleStoreRun(runId, client, jsonl);
  } catch (err) {
    // Ambiguous relaunch → stay PENDING, store held. See relaunchCustomerRun.
    if (!isAmbiguousSubmitError(err)) throw err;
    await recordAmbiguousSubmit(
      prisma.productImportRun as never,
      runId,
      `${AMBIGUOUS_SUBMIT_MESSAGE} (${(err as Error).message})`,
    );
  }
}

export function productResumableStores(): ResumableStore[] {
  return [
    {
      label: 'product-run',
      findResumable: (staleBefore) => findResumableRows(prisma.productImportRun as never, staleBefore),
      claim: (id, staleBefore) => claimRow(prisma.productImportRun as never, id, staleBefore),
      relaunch: relaunchProductRun,
      fail: (id, error) => failRow(prisma.productImportRun as never, id, error),
      lockOwner: (row) => ({
        ownerType: 'PRODUCT_IMPORT_RUN',
        ownerId: row.id,
        operation: 'a product import',
      }),
    },
    {
      label: 'product-job',
      findResumable: (staleBefore) =>
        findResumableRows(prisma.productImportJob as never, staleBefore, { withParent: true }),
      claim: (id, staleBefore) => claimRow(prisma.productImportJob as never, id, staleBefore),
      relaunch: relaunchProductJob,
      fail: (id, error) => failRow(prisma.productImportJob as never, id, error),
      // A job's store is held by its SHARE, so two PENDING siblings on one store both
      // re-take the same lock (re-entrant) instead of the second being told the
      // store is busy by its own sibling. A job with no store has no share; it
      // falls back to its own id, and the relaunch fails it anyway.
      lockOwner: (row) =>
        row.importRunId && row.storeId
          ? {
              ownerType: 'PRODUCT_IMPORT_STORE_SHARE',
              ownerId: shareOwner(row.importRunId, row.storeId),
              operation: 'a product import',
            }
          : { ownerType: 'PRODUCT_IMPORT_JOB', ownerId: row.id, operation: 'a product import' },
    },
  ];
}
