import { awaitCleanupRuns, CleanupRun } from './cleanupPoller';
import { createApiClient, healthFromResponse, storesFromResponse } from './http';
import {
  ColumnMapping,
  CleanupResult,
  CsvPreview,
  ImportFeedback,
  ShopifyHealth,
  BusyStore,
  ShopifyStore,
  StoreCustomerStats,
  UpdateMetadataPayload,
  ValidationHistoryItem,
  ValidationResult,
  ValidationSummary,
} from '../types';

// Actor header + the server's { error } sentence on failures (see http.ts).
const api = createApiClient();

export async function previewCsv(file: File): Promise<CsvPreview> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post<CsvPreview>('/customer-validation/preview', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

/** The mapping screen's checkboxes. One object rather than a row of positional
 *  booleans — they all look alike at a call site. */
export interface TemplateFlags {
  heliosMigratedTag: boolean;
  moveDuplicatesToNotes: boolean;
  mergeMatchingDuplicates: boolean;
  moveInvalidContactToNotes: boolean;
  fillMissingContactName: boolean;
}

/** Flags whose effect is previewed per option. HeliosMigratedTag is excluded —
 *  it tags rows, it does not change whether any of them import. */
export type PreviewableFlag =
  | 'moveInvalidContactToNotes'
  | 'fillMissingContactName'
  | 'mergeMatchingDuplicates'
  | 'moveDuplicatesToNotes';

export interface EffectsPreview {
  current: ValidationSummary;
  toggled: Record<PreviewableFlag, ValidationSummary>;
}

/** Read-only: what each option would do to this file. Persists nothing and does
 *  not consume the preview, so it is safe to call on every toggle. */
export async function previewFlagEffects(
  uploadId: string,
  columnMapping: ColumnMapping,
  flags: TemplateFlags,
): Promise<EffectsPreview> {
  const { data } = await api.post<EffectsPreview>('/customer-validation/preview-effects', {
    uploadId,
    columnMapping,
    ...flags,
  });
  return data;
}

export async function validateWithMapping(
  uploadId: string,
  columnMapping: ColumnMapping,
  flags: TemplateFlags,
): Promise<ValidationResult> {
  const { data } = await api.post<ValidationResult>('/customer-validation/validate', {
    uploadId,
    columnMapping,
    ...flags,
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

/** `mineOnly` narrows the list to this browser's actor. A VIEW preference, not a
 *  permission — everything is still readable without it (see api/actor.ts). The
 *  server resolves "me" from the X-QA-User header, so the name is never repeated
 *  in the URL and the two cannot disagree. */
export async function fetchHistory(
  mineOnly = false,
): Promise<ValidationHistoryItem[]> {
  const { data } = await api.get<ValidationHistoryItem[]>(
    '/customer-validation/history',
    { params: mineOnly ? { createdBy: 'me' } : undefined },
  );
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

/** Throws the server's error + hint when the instance has no usable stores. */
export async function fetchShopifyStores(): Promise<ShopifyStore[]> {
  const { data, status } = await api.get<unknown>('/shopify/stores', {
    validateStatus: () => true,
  });
  return storesFromResponse<ShopifyStore>(status, data);
}

/** Stores busy with an import or cleanup right now (shared with the product
 *  picker). Empty on any error: this only decorates the picker. */
export async function fetchBusyStores(): Promise<BusyStore[]> {
  const { data, status } = await api.get<{ busy: BusyStore[] }>('/shopify/stores/busy', {
    validateStatus: () => true,
  });
  return status === 200 ? data.busy ?? [] : [];
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
  // either way rather than throwing. A body without `ok` reads as not ready.
  const { data, status } = await api.get<unknown>('/shopify/health', {
    params: storeId ? { storeId } : undefined,
    validateStatus: () => true,
  });
  return healthFromResponse<ShopifyHealth>(status, data);
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

// Latest import for a validation run, or null when none exists. Used to
// restore/resume an import when a run is reopened from History.
export async function fetchLatestImportForValidation(
  validationId: string,
): Promise<ImportFeedback | null> {
  const { data, status } = await api.get<ImportFeedback | null>(
    `/customer-import/by-validation/${encodeURIComponent(validationId)}`,
    { validateStatus: () => true },
  );
  // 200 with null = never imported (older servers answered 404).
  return status === 200 && data ? data : null;
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
