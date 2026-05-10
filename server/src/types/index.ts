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

export interface ValidationHistoryItem {
  id: string;
  fileName: string;
  fileType: string;
  totalRows: number;
  errors: number;
  warnings: number;
  info: number;
  createdAt: Date;
}

// Shape stored in ValidationRun.affectedRows JSON field
export interface AffectedRow {
  rowNumber: number;
  data: Record<string, string>;
}
