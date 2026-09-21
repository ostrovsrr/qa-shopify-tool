export type Severity = 'Error';

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

/**
 * What became of every row, for the Validation Results cards.
 *
 * `ready + fixed + blocked + removed === totalRows`. Each row lands in exactly
 * one of those four, which is the property that makes the summary trustworthy —
 * if they stop summing, something is being double-counted. A row that qualifies
 * for several is resolved by precedence: BLOCKED WINS. If anything still fails
 * on a row it is not "fixed", however much the tool did to it.
 *
 * The breakdown fields do NOT obey that rule and are not meant to. One row can
 * carry two fixes (an invalid email moved AND a placeholder name), and one row
 * can be both an email and a phone duplicate, so the parts can exceed the whole.
 * That is why `duplicateBoth` is reported: without it `duplicateEmail +
 * duplicatePhone != duplicateRecords` reads as a bug.
 */
export interface ValidationSummary {
  totalRows: number;
  /** Imports as-is; the tool changed nothing. */
  ready: number;
  /** Changed by the tool so Shopify will accept it. */
  fixed: number;
  /** Still fails — needs manual work. Records, not issues. */
  blocked: number;
  /** Left the file: blank lines dropped, or merged into another record. */
  removed: number;

  /** Records (not fixes) per kind of fix; these may overlap. */
  fixedInvalidContact: number;
  fixedDuplicates: number;
  fixedNamed: number;

  removedBlank: number;
  removedMerged: number;

  /** Duplicate diagnostics. NOT part of the four buckets — a duplicate is
   *  `fixed` when it was moved to Note and `blocked` when it was not, so this
   *  cuts across them. Counts the REPEATS that Shopify would reject, never the
   *  keeper, which imports fine. */
  duplicateRecords: number;
  duplicateEmail: number;
  duplicatePhone: number;
  /** Records duplicated on BOTH email and phone — counted once in
   *  duplicateRecords and in each of the two above. */
  duplicateBoth: number;
  duplicateGroups: number;

  /** Individual Error issues. `blocked` counts the ROWS they sit on. */
  errorCount: number;
}

export interface CustomerValidationResult {
  validationId: string;
  fileName: string;
  totalRows: number;
  errors: number;
  issues: CustomerValidationIssue[];
  /** Absent on runs validated before the summary existed. */
  summary?: ValidationSummary | null;
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
  createdBy: string | null;
  piiPurgedAt: Date | null;
  fileName: string;
  fileType: string;
  totalRows: number;
  errors: number;
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

// Product pre-check: the customer issue shape plus the Handle, since the import
// unit is a product and one product spans several rows.
export interface ProductValidationIssue extends CustomerValidationIssue {
  handle: string;
}

export interface ProductValidationRule {
  name: string;
  validate(groups: ProductGroup[]): ProductValidationIssue[];
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
  createdBy: string | null;
  piiPurgedAt: Date | null;
  fileName: string;
  productCount: number;
  // Pre-check errors at upload; null = uploaded before the product pre-check existed.
  precheckErrors: number | null;
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
