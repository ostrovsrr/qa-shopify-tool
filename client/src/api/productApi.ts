import { awaitCleanupRuns, CleanupRun } from './cleanupPoller';
import { createApiClient, healthFromResponse, storesFromResponse } from './http';
import {
  ProductCleanupResult,
  ProductHistoryItem,
  ProductImportFeedback,
  ShopifyHealth,
  BusyStore,
  ShopifyStore,
  StoreProductStats,
  UpdateMetadataPayload,
  UploadDetail,
  UploadSummary,
} from '../types';

// Actor header + the server's { error } sentence on failures (see http.ts) —
// the same client validationApi uses; the two flows are twins.
const api = createApiClient();

// ── upload (parse + persist; no mapping/validate) ────────────────────────────

export async function uploadProductCsv(file: File): Promise<UploadSummary> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post<UploadSummary>('/product-upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function fetchUpload(uploadId: string): Promise<UploadDetail> {
  const { data } = await api.get<UploadDetail>(`/product-upload/${uploadId}`);
  return data;
}

/** Twin of the customer fetchHistory — same semantics, deliberately identical.
 *  A view preference, not a permission. */
export async function fetchHistory(
  mineOnly = false,
): Promise<ProductHistoryItem[]> {
  const { data } = await api.get<ProductHistoryItem[]>('/product-upload/history', {
    params: mineOnly ? { createdBy: 'me' } : undefined,
  });
  return data;
}

export async function updateUploadMetadata(
  uploadId: string,
  payload: UpdateMetadataPayload,
): Promise<ProductHistoryItem> {
  const { data } = await api.patch<ProductHistoryItem>(
    `/product-upload/${uploadId}/metadata`,
    payload,
  );
  return data;
}

export async function deleteUpload(uploadId: string): Promise<void> {
  await api.delete(`/product-upload/${uploadId}`);
}

/** The pre-check workbook for an upload, before any import (twin of the
 *  customer prevalidation report). */
export function getPrecheckReportDownloadUrl(uploadId: string): string {
  return `/api/product-upload/${uploadId}/report`;
}

export function getImportReportDownloadUrl(importRunId: string): string {
  return `/api/product-import/${importRunId}/report`;
}

// ── Shopify test-store import + feedback ─────────────────────────────────────

/** Throws the server's error + hint when the instance has no usable stores. */
export async function fetchShopifyStores(): Promise<ShopifyStore[]> {
  const { data, status } = await api.get<unknown>('/shopify/stores', {
    validateStatus: () => true,
  });
  return storesFromResponse<ShopifyStore>(status, data);
}

/** Twin of the customer fetchBusyStores — the lock is per store, not per flow,
 *  so a customer import shows here too. */
export async function fetchBusyStores(): Promise<BusyStore[]> {
  const { data, status } = await api.get<{ busy: BusyStore[] }>('/shopify/stores/busy', {
    validateStatus: () => true,
  });
  return status === 200 ? data.busy ?? [] : [];
}

export async function fetchStoreProductStats(storeId: string): Promise<StoreProductStats> {
  const { data } = await api.get<StoreProductStats>(
    `/shopify/stores/${encodeURIComponent(storeId)}/product-stats`,
  );
  return data;
}

// Cleanup is async on the server: the POST returns 202 with a run, and the delete
// is advanced one step per poll. awaitCleanupRuns watches it to completion and
// returns the same shape the UI already renders.
export async function cleanupQaProducts(storeId: string): Promise<ProductCleanupResult> {
  const { data } = await api.post<CleanupRun>(
    `/shopify/stores/${encodeURIComponent(storeId)}/cleanup-qa-products`,
  );
  return awaitCleanupRuns([data]);
}

export async function checkShopifyHealth(storeId?: string): Promise<ShopifyHealth> {
  // /health returns non-2xx (422/503/401) when misconfigured; surface the body
  // either way rather than throwing. A body without `ok` reads as not ready.
  const { data, status } = await api.get<unknown>('/shopify/health', {
    params: storeId ? { storeId } : undefined,
    validateStatus: () => true,
  });
  return healthFromResponse<ShopifyHealth>(status, data);
}

export async function runImport(
  uploadId: string,
  storeId?: string,
): Promise<ProductImportFeedback> {
  const { data } = await api.post<ProductImportFeedback>(
    `/product-import/${uploadId}/run`,
    { storeId },
  );
  return data;
}

// Parallel batch import: split the products across several stores. Returns the
// parent feedback (status RUNNING); poll it like a normal import until terminal.
export async function runBatchImport(
  uploadId: string,
  storeIds: string[],
): Promise<ProductImportFeedback> {
  const { data } = await api.post<ProductImportFeedback>(
    `/product-import/${uploadId}/run-batch`,
    { storeIds },
  );
  return data;
}

export async function fetchImportFeedback(importRunId: string): Promise<ProductImportFeedback> {
  const { data } = await api.get<ProductImportFeedback>(`/product-import/${importRunId}`);
  return data;
}

// Latest import for an upload, or null when none exists. Used to
// restore/resume an import when an upload is reopened from History.
export async function fetchLatestImportForUpload(
  uploadId: string,
): Promise<ProductImportFeedback | null> {
  const { data, status } = await api.get<ProductImportFeedback | null>(
    `/product-import/by-upload/${encodeURIComponent(uploadId)}`,
    { validateStatus: () => true },
  );
  // 200 with null = never imported (older servers answered 404).
  return status === 200 && data ? data : null;
}

// Batch-aware: one cleanup run per store the import touched. Poll them all.
export async function cleanupImportRun(
  importRunId: string,
  storeId?: string,
): Promise<ProductCleanupResult> {
  const { data } = await api.post<CleanupRun[]>(
    `/product-import/${importRunId}/cleanup`,
    { storeId },
  );
  return awaitCleanupRuns(data);
}
