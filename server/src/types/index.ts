export type Severity = 'Error' | 'Warning' | 'Info';

export interface CustomerCsvRow {
  rowNumber: number;
  original: Record<string, string>;
  normalized: Record<string, string>;
}

export interface CustomerValidationIssue {
  rowNumber: number;
  column: string;
  severity: Severity;
  issueType: string;
  currentValue: string;
  message: string;
  suggestedFix: string;
}

export interface CustomerValidationResult {
  validationId: string;
  fileName: string;
  totalRows: number;
  errors: number;
  warnings: number;
  info: number;
  issues: CustomerValidationIssue[];
}

export interface CustomerValidationRule {
  name: string;
  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[];
}

// The most recent Shopify import for a validation run, so History can show at a
// glance whether a run was imported and how it landed. Null = never imported.
export interface ValidationHistoryImport {
  status: string;
  successCount: number;
  errorCount: number;
  createdAt: Date;
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
  createdAt: Date;
  updatedAt: Date;
  lastImport: ValidationHistoryImport | null;
}

export interface UpdateValidationMetadata {
  ticketNumber?: string | null;
  ticketName?: string | null;
  comments?: string | null;
}

// Shape stored in ValidationRun.affectedRows JSON field
export interface AffectedRow {
  rowNumber: number;
  data: Record<string, string>;
}
