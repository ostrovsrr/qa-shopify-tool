import axios from 'axios';
import { attachActorHeader } from './actor';
import { awaitCleanupRuns, CleanupRun } from './cleanupPoller';
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

// Every request says who made it — display + audit only, never authorization.
attachActorHeader(api);

// Surface the server's { error } message instead of Axios's generic
// "Request failed with status code N".
api.interceptors.response.use(undefined, (err: unknown) => {
  if (axios.isAxiosError(err) && typeof err.response?.data?.error === 'string') {
    err.message = err.response.data.error;
  }
  return Promise.reject(err);
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
  moveDuplicatesToNotes: boolean,
  mergeMatchingDuplicates: boolean,
): Promise<ValidationResult> {
  const { data } = await api.post<ValidationResult>('/customer-validation/validate', {
    uploadId,
    columnMapping,
    heliosMigratedTag,
    moveDuplicatesToNotes,
    mergeMatchingDuplicates,
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

export function getValidatorFeedbackReportUrl(importRunId: string): string {
  return `/api/customer-import/${importRunId}/feedback-report`;
}

// Markdown body of the validator-fix report, for copying to the clipboard.
export async function fetchValidatorFeedbackMarkdown(importRunId: string): Promise<string> {
  const { data } = await api.get<string>(
    `/customer-import/${importRunId}/feedback-report`,
    { responseType: 'text', transformResponse: (d) => d },
  );
  return data;
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

// Cleanup is async on the server: the POST returns 202 with a run, and the delete
// is advanced one step per poll. awaitCleanupRuns watches it to completion and
// returns the same shape the UI already renders.
export async function cleanupQaCustomers(storeId: string): Promise<CleanupResult> {
  const { data } = await api.post<CleanupRun>(
    `/shopify/stores/${encodeURIComponent(storeId)}/cleanup-qa`,
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

// Parallel batch import: split the run across several stores. Returns the parent
// ImportFeedback (status RUNNING); poll it like a normal import until terminal.
export async function runBatchImport(
  validationId: string,
  storeIds: string[],
): Promise<ImportFeedback> {
  const { data } = await api.post<ImportFeedback>(
    `/customer-import/${validationId}/run-batch`,
    { storeIds },
  );
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

// Batch-aware: one cleanup run per store the import touched. Poll them all.
export async function cleanupImportRun(
  importRunId: string,
  storeId?: string,
): Promise<CleanupResult> {
  const { data } = await api.post<CleanupRun[]>(
    `/customer-import/${importRunId}/cleanup`,
    { storeId },
  );
  return awaitCleanupRuns(data);
}
