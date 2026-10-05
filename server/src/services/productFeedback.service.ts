import prisma from '../db/prisma';
import { storeLabeller } from './importFeedback.service';

// Without a validator there's nothing to compare against, so there is no
// four-bucket report. The feedback IS the import truth: total / accepted /
// rejected, with rejections grouped by the real productSet (field, code), plus a
// per-store breakdown for parallel runs.

export interface RejectionGroup {
  shopifyField: string | null;
  shopifyCode: string | null;
  count: number;
  // Up to 3 distinct Shopify messages and up to 10 example Handles for this group.
  sampleMessages: string[];
  sampleHandles: string[];
  // Our own explanation, for the Shopify codes whose wording sends people to
  // the wrong place. Null when the message speaks for itself.
  hint: string | null;
}

export interface PerStoreResult {
  storeId: string | null;
  shopDomain: string;
  total: number;
  accepted: number;
  rejected: number;
}

export interface ProductImportFeedback {
  importRunId: string;
  uploadId: string;
  // Store this import actually ran against (null = default store, or a batch
  // parent whose stores live on its jobs).
  storeId: string | null;
  shopDomain: string;
  status: string;
  // Reason for a terminal failure (FAILED/CANCELED/EXPIRED); null otherwise.
  error: string | null;
  successCount: number;
  errorCount: number;
  totalProducts: number;
  accepted: number;
  rejected: number;
  createdAt: Date;
  // Rejections grouped by (field, code), highest-count first.
  rejectionGroups: RejectionGroup[];
  // Per-store accepted/rejected split (one entry per store for a batch; a single
  // entry for a single-store run).
  perStore: PerStoreResult[];
}

// Shopify reports a missing metafield DEFINITION as field "type", code
// INVALID_METAFIELD, message "Type can't be blank" — which reads exactly like a
// complaint about the product's Type column. It is not: we send metafields
// without a type on purpose and let Shopify resolve it from the definition on
// the store (see productImport.service.ts), so a store with no matching
// definition rejects the product while its Type column is plainly filled in.
// Anyone reading the raw message goes and checks the wrong column.
export function hintFor(field: string | null, code: string | null): string | null {
  if (code !== 'INVALID_METAFIELD') return null;
  if (field !== null && field.toLowerCase() !== 'type') return null;
  return (
    'This is about a metafield definition, not the product\'s Type column. ' +
    'The import sends metafield values without a type and lets Shopify read it ' +
    'from the definition on the store, so a metafield column in the CSV with no ' +
    'matching definition fails this way. Create the definitions on the store ' +
    '(Settings → Custom data), then re-import.'
  );
}

const SAMPLE_MESSAGES = 3;
const SAMPLE_HANDLES = 10;

/**
 * Rejections grouped by (field, code), highest-count first, each with up to 3
 * distinct messages (the most frequent) and up to 10 example Handles.
 *
 * Counted and sampled in the database: this runs on every status poll, and a file
 * Shopify rejects wholesale can have as many rejected rows as products. There are
 * only ever a handful of (field, code) groups, so two small queries per group stay
 * cheap where loading every rejected row did not.
 */
async function rejectionGroupsFor(importRunId: string): Promise<RejectionGroup[]> {
  const groups = await prisma.productImportResult.groupBy({
    by: ['shopifyField', 'shopifyCode'],
    where: { importRunId, accepted: false },
    _count: { _all: true },
  });

  const out = await Promise.all(
    groups.map(async (g): Promise<RejectionGroup> => {
      const inGroup = {
        importRunId,
        accepted: false,
        shopifyField: g.shopifyField,
        shopifyCode: g.shopifyCode,
      };
      const [messages, handles] = await Promise.all([
        prisma.productImportResult.groupBy({
          by: ['message'],
          where: { ...inGroup, message: { not: null } },
          orderBy: { _count: { message: 'desc' } },
          take: SAMPLE_MESSAGES,
        }),
        // A run holds one result per product, so the Handles are already distinct.
        prisma.productImportResult.findMany({
          where: inGroup,
          select: { handle: true },
          take: SAMPLE_HANDLES,
        }),
      ]);
      return {
        shopifyField: g.shopifyField,
        shopifyCode: g.shopifyCode,
        count: g._count._all,
        sampleMessages: messages.map((m) => m.message).filter((m): m is string => Boolean(m)),
        sampleHandles: [...new Set(handles.map((h) => h.handle))],
        hint: hintFor(g.shopifyField, g.shopifyCode),
      };
    }),
  );
  return out.sort((a, b) => b.count - a.count);
}

export async function getProductImportFeedback(
  importRunId: string,
): Promise<ProductImportFeedback | null> {
  // Called on every status poll — aggregate in the database instead of loading
  // every result row of a large import. See the customer twin.
  const run = await prisma.productImportRun.findUnique({
    where: { id: importRunId },
    include: { batchJobs: { select: { storeId: true, shopDomain: true } } },
  });
  if (!run) return null;

  const counts = await prisma.productImportResult.groupBy({
    by: ['storeId', 'accepted'],
    where: { importRunId },
    _count: { _all: true },
  });

  // Per-store split, labelled with the store's shop domain.
  const shopLabel = storeLabeller(run);
  const perStoreMap = new Map<string, PerStoreResult>();
  let total = 0;
  let accepted = 0;
  for (const c of counts) {
    const n = c._count._all;
    total += n;
    if (c.accepted) accepted += n;
    const key = c.storeId ?? '';
    let entry = perStoreMap.get(key);
    if (!entry) {
      entry = { storeId: c.storeId, shopDomain: shopLabel(c.storeId), total: 0, accepted: 0, rejected: 0 };
      perStoreMap.set(key, entry);
    }
    entry.total += n;
    if (c.accepted) entry.accepted += n;
    else entry.rejected += n;
  }
  const perStore = [...perStoreMap.values()].sort((a, b) => b.total - a.total);
  const rejected = total - accepted;

  return {
    importRunId: run.id,
    uploadId: run.uploadId,
    storeId: run.storeId,
    shopDomain: run.shopDomain,
    status: run.status,
    error: run.error,
    successCount: run.successCount,
    errorCount: run.errorCount,
    totalProducts: total,
    accepted,
    rejected,
    createdAt: run.createdAt,
    rejectionGroups: rejected > 0 ? await rejectionGroupsFor(importRunId) : [],
    perStore,
  };
}
