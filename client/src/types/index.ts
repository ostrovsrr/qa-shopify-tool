export type Severity = 'Error' | 'Warning' | 'Info';

export interface ValidationIssue {
  rowNumber: number;
  column: string;
  severity: Severity;
  issueType: string;
  currentValue: string;
  message: string;
  suggestedFix: string;
}

export interface ValidationResult {
  validationId: string;
  fileName: string;
  totalRows: number;
  errors: number;
  warnings: number;
  info: number;
  issues: ValidationIssue[];
}

export interface ValidationHistoryItem {
  id: string;
  fileName: string;
  fileType: string;
  totalRows: number;
  errors: number;
  warnings: number;
  info: number;
  ticketNumber: string | null;
  ticketName: string | null;
  comments: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateMetadataPayload {
  ticketNumber?: string | null;
  ticketName?: string | null;
  comments?: string | null;
}

// Column mapping: source CSV column → Shopify target column (empty string = ignore)
export type ColumnMapping = Record<string, string>;

export interface CsvPreview {
  uploadId: string;
  fileName: string;
  headers: string[];
  sampleRows: Record<string, string>[];
  suggestedMapping: ColumnMapping;
}
