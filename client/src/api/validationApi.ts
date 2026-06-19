import axios from 'axios';
import {
  ColumnMapping,
  CsvPreview,
  ImportFeedback,
  ShopifyHealth,
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

export async function checkShopifyHealth(): Promise<ShopifyHealth> {
  // /health returns non-2xx (422/503/401) when misconfigured; surface the body
  // either way rather than throwing.
  const { data } = await api.get<ShopifyHealth>('/shopify/health', {
    validateStatus: () => true,
  });
  return data;
}

export async function runImport(validationId: string): Promise<ImportFeedback> {
  const { data } = await api.post<ImportFeedback>(
    `/customer-import/${validationId}/run`,
  );
  return data;
}

export async function fetchImportFeedback(importRunId: string): Promise<ImportFeedback> {
  const { data } = await api.get<ImportFeedback>(`/customer-import/${importRunId}`);
  return data;
}
