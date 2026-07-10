import axios from 'axios';
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

export async function cleanupQaProducts(storeId: string): Promise<ProductCleanupResult> {
  const { data } = await api.post<ProductCleanupResult>(
    `/shopify/stores/${encodeURIComponent(storeId)}/cleanup-qa-products`,
  );
  return data;
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

export async function cleanupImportRun(
  importRunId: string,
  storeId?: string,
): Promise<ProductCleanupResult> {
  const { data } = await api.post<ProductCleanupResult>(
    `/product-import/${importRunId}/cleanup`,
    { storeId },
  );
  return data;
}
