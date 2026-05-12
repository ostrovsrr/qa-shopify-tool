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
