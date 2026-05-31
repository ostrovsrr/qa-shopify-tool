import axios from 'axios';
import {
  ColumnMapping,
  CsvPreview,
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
): Promise<ValidationResult> {
  const { data } = await api.post<ValidationResult>('/customer-validation/validate', {
    uploadId,
    columnMapping,
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
