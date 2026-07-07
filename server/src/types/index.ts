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

// ── Products ──

// One parsed CSV row. `rowNumber` is the 1-based line number in the source file
// (header is line 1, so the first data row is 2), matching how a human reads the CSV.
export interface ProductCsvRow {
  rowNumber: number;
  original: Record<string, string>;
  normalized: Record<string, string>;
}

// The import unit: all rows sharing a Handle. The first row carries the
// product-level fields (Title, Body, Vendor, …, Option*Name); subsequent rows add
// variants and images. Products are counted by group, not by CSV row.
export interface ProductGroup {
  handle: string;
  rows: ProductCsvRow[];
}

export interface ParsedProductCsv {
  rows: ProductCsvRow[];
  headers: string[];
  groups: ProductGroup[];
}

// One result per product (keyed by Handle) after a bulk productSet line is parsed.
// Unlike the customer tool, `shopifyCode` is the real ProductSetUserError code —
// no synthesis — so the report can group rejections on (shopifyField, shopifyCode).
export interface ProductImportOutcome {
  handle: string;
  accepted: boolean;
  shopifyProductId: string | null;
  shopifyCode: string | null;
  shopifyField: string | null;
  message: string | null;
}

// The most recent Shopify import for an upload, so History can show at a glance
// whether it was imported and how it landed. Null = never imported.
export interface ProductHistoryImport {
  status: string;
  successCount: number;
  errorCount: number;
  createdAt: Date;
}

export interface ProductHistoryItem {
  id: string;
  fileName: string;
  productCount: number;
  ticketNumber: string | null;
  ticketName: string | null;
  comments: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastImport: ProductHistoryImport | null;
}

export interface UpdateUploadMetadata {
  ticketNumber?: string | null;
  ticketName?: string | null;
  comments?: string | null;
}
