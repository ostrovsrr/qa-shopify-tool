import type { BatchStore, PerStoreResult, ShopifyStore } from '../types';

interface RunStoresSource {
  storeId: string | null;
  shopDomain: string;
  perStore: PerStoreResult[];
  batchStores?: BatchStore[];
}

/**
 * The store ids an import run ran against, for pointing the picker at a run
 * reopened from History. Shared by the customer and product panels (twins).
 *
 * A parallel run's parent has storeId null and shopDomain "a, b", which matches
 * no single store, and perStore is built from row results — empty until a job
 * finishes. Reading only those reopened a RUNNING parallel import on the DEFAULT
 * store, with a live Clean QA aimed at a store the run never touched. batchStores
 * comes from the job rows and is known from the start, so it wins; the joined
 * domain list is the fallback for a server that does not send it yet.
 */
export function resolveRunStoreIds(run: RunStoresSource | null, stores: ShopifyStore[]): string[] {
  if (!run) return [];
  const resolve = (storeId: string | null, shopDomain: string) =>
    storeId ?? stores.find((s) => s.shop === shopDomain)?.id;

  let candidates: (string | undefined)[];
  if (run.batchStores && run.batchStores.length > 0) {
    candidates = run.batchStores.map((b) => resolve(b.storeId, b.shopDomain));
  } else if (run.perStore.length > 1) {
    candidates = run.perStore.map((ps) => resolve(ps.storeId, ps.shopDomain));
  } else if (!run.storeId && run.shopDomain.includes(', ')) {
    candidates = run.shopDomain.split(', ').map((d) => resolve(null, d));
  } else {
    candidates = [resolve(run.storeId, run.shopDomain)];
  }
  return [...new Set(candidates.filter((id): id is string => !!id))];
}
