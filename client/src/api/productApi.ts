import axios from 'axios';
import { attachActorHeader } from './actor';
import { awaitCleanupRuns, CleanupRun } from './cleanupPoller';
import {
  ProductCleanupResult,
  ProductHistoryItem,
  ProductImportFeedback,
  ShopifyHealth,
  ShopifyStore,
  StoreProductStats,
  UpdateMetadataPayload,
  UploadDetail,
  UploadSummary,
} from '../types';

const api = axios.create({ baseURL: '/api' });

// Every request says who made it — display + audit only, never authorization.
attachActorHeader(api);

// Surface the server's { error } message instead of Axios's generic "Request failed
// with status code N". Without this a busy store (409) reads as "Request failed with
// status code 409" — the one message that tells the user nothing about what to do —
// rather than "Store store1 is busy: a product import has been running for ~2 min."
// Mirrors validationApi (the two flows are twins).
api.interceptors.response.use(undefined, (err: unknown) => {
  if (axios.isAxiosError(err) && typeof err.response?.data?.error === 'string') {
    err.message = err.response.data.error;
  }
  return Promise.reject(err);
});

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

export async function fetchHistory(): Promise<ProductHistoryItem[]> {
  const { data } = await api.get<ProductHistoryItem[]>('/product-upload/history');
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

export function getImportReportDownloadUrl(importRunId: string): string {
  return `/api/product-import/${importRunId}/report`;
}

// ── Shopify test-store import + feedback ─────────────────────────────────────

export async function fetchShopifyStores(): Promise<ShopifyStore[]> {
  const { data } = await api.get<{ stores: ShopifyStore[] }>('/shopify/stores', {
    validateStatus: () => true,
  });
  return data.stores ?? [];
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
  // either way rather than throwing.
  const { data } = await api.get<ShopifyHealth>('/shopify/health', {
    params: storeId ? { storeId } : undefined,
    validateStatus: () => true,
  });
  return data;
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

// Latest import for an upload, or null when none exists (404). Used to
// restore/resume an import when an upload is reopened from History.
export async function fetchLatestImportForUpload(
  uploadId: string,
): Promise<ProductImportFeedback | null> {
  const { data, status } = await api.get<ProductImportFeedback>(
    `/product-import/by-upload/${encodeURIComponent(uploadId)}`,
    { validateStatus: () => true },
  );
  return status === 200 ? data : null;
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
