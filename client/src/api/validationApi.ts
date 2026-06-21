import axios from 'axios';
import {
  ColumnMapping,
  CleanupResult,
  CsvPreview,
  ImportFeedback,
  ShopifyHealth,
  ShopifyStore,
  StoreCustomerStats,
  UpdateMetadataPayload,
  ValidationHistoryItem,
  ValidationResult,
} from '../types';

const api = axios.create({
  baseURL: '/api',
});

export async function previewCsv(file: File): Promise<CsvPreview> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post<CsvPreview>('/customer-validation/preview', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function validateWithMapping(
  uploadId: string,
  columnMapping: ColumnMapping,
  heliosMigratedTag: boolean,
): Promise<ValidationResult> {
  const { data } = await api.post<ValidationResult>('/customer-validation/validate', {
    uploadId,
    columnMapping,
    heliosMigratedTag,
  });
  return data;
}

export async function uploadCustomerCsv(file: File): Promise<ValidationResult> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post<ValidationResult>('/customer-validation/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function fetchValidationResult(validationId: string): Promise<ValidationResult> {
  const { data } = await api.get<ValidationResult>(`/customer-validation/${validationId}`);
  return data;
}

export function getReportDownloadUrl(validationId: string): string {
  return `/api/customer-validation/report/${validationId}`;
}

export function getImportReportDownloadUrl(importRunId: string): string {
  return `/api/customer-import/${importRunId}/report`;
}

export async function fetchHistory(): Promise<ValidationHistoryItem[]> {
  const { data } = await api.get<ValidationHistoryItem[]>('/customer-validation/history');
  return data;
}

export async function updateValidationMetadata(
  validationId: string,
  payload: UpdateMetadataPayload,
): Promise<ValidationHistoryItem> {
  const { data } = await api.patch<ValidationHistoryItem>(
    `/customer-validation/${validationId}/metadata`,
    payload,
  );
  return data;
}

export async function deleteValidation(validationId: string): Promise<void> {
  await api.delete(`/customer-validation/${validationId}`);
}

// ── Shopify test-store import + feedback ─────────────────────────────────────

export async function fetchShopifyStores(): Promise<ShopifyStore[]> {
  const { data } = await api.get<{ stores: ShopifyStore[] }>('/shopify/stores', {
    validateStatus: () => true,
  });
  return data.stores ?? [];
}

export async function fetchStoreCustomerStats(
  storeId: string,
): Promise<StoreCustomerStats> {
  const { data } = await api.get<StoreCustomerStats>(
    `/shopify/stores/${encodeURIComponent(storeId)}/stats`,
  );
  return data;
}

export async function cleanupQaCustomers(storeId: string): Promise<CleanupResult> {
  const { data } = await api.post<CleanupResult>(
    `/shopify/stores/${encodeURIComponent(storeId)}/cleanup-qa`,
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
  validationId: string,
  storeId?: string,
): Promise<ImportFeedback> {
  const { data } = await api.post<ImportFeedback>(
    `/customer-import/${validationId}/run`,
    { storeId },
  );
  return data;
}

export async function fetchImportFeedback(importRunId: string): Promise<ImportFeedback> {
  const { data } = await api.get<ImportFeedback>(`/customer-import/${importRunId}`);
  return data;
}

// Latest import for a validation run, or null when none exists (404). Used to
// restore/resume an import when a run is reopened from History.
export async function fetchLatestImportForValidation(
  validationId: string,
): Promise<ImportFeedback | null> {
  const { data, status } = await api.get<ImportFeedback>(
    `/customer-import/by-validation/${encodeURIComponent(validationId)}`,
    { validateStatus: () => true },
  );
  return status === 200 ? data : null;
}

export async function cleanupImportRun(
  importRunId: string,
  storeId?: string,
): Promise<CleanupResult> {
  const { data } = await api.post<CleanupResult>(
    `/customer-import/${importRunId}/cleanup`,
    { storeId },
  );
  return data;
}
