import { v4 as uuidv4 } from 'uuid';
import prisma from '../db/prisma';
import { CsvParseError } from '../errors';
import { parseProductCsvFile } from './productCsvParser';
import { ProductHistoryItem, ProductValidationIssue, UpdateUploadMetadata } from '../types';
import { clampHistoryLimit, HistoryQuery } from './customerValidation.service';
import { runProductValidation } from '../validators/product';

// Upload: parse the product CSV, group by Handle, run the file-level pre-check
// (validators/product), and persist the run, its raw rows and its findings. No
// column mapping — the CSV is already in Shopify template format. The pre-check
// predicts rejections; it never blocks the import, which stays the truth.

export interface UploadSummary {
  uploadId: string;
  fileName: string;
  productCount: number;
  rowCount: number;
  headers: string[];
  precheckErrors: number;
  issues: ProductValidationIssue[];
}

type StoredIssue = {
  rowNumber: number;
  handle: string;
  columnName: string;
  severity: string;
  issueType: string;
  currentValue: string | null;
  message: string;
  suggestedFix: string | null;
};

// DB row → API shape (the same `column` naming the customer issues use).
function toApiIssue(i: StoredIssue): ProductValidationIssue {
  return {
    rowNumber: i.rowNumber,
    handle: i.handle,
    column: i.columnName,
    severity: 'Error',
    issueType: i.issueType,
    currentValue: i.currentValue ?? '',
    message: i.message,
    suggestedFix: i.suggestedFix ?? '',
  };
}

export async function createProductUpload(
  filePath: string,
  fileName: string,
  // Display + audit only. NEVER a filter on who may see this upload.
  createdBy?: string,
): Promise<UploadSummary> {
  const parsed = await parseProductCsvFile(filePath);
  if (parsed.rows.length === 0) {
    throw new CsvParseError('The file contains a header row but no product data rows.');
  }
  if (!parsed.headers.includes('Handle')) {
    throw new CsvParseError('A Shopify product CSV must contain a "Handle" column.');
  }
  if (parsed.groups.length === 0) {
    throw new CsvParseError('No products were found. At least one row must have a non-empty Handle.');
  }
  const uploadId = uuidv4();
  const issues = runProductValidation(parsed.groups);

  // Chunk the row insert so one createMany doesn't serialize the whole CSV
  // into a single query on large files (same pattern as the customer side).
  const CHUNK = 5000;
  await prisma.$transaction(
    async (tx) => {
      await tx.productUploadRun.create({
        data: {
          id: uploadId,
          createdBy: createdBy ?? null,
          fileName,
          productCount: parsed.groups.length,
          originalColumns: parsed.headers,
          precheckErrors: issues.length,
        },
      });

      for (let i = 0; i < parsed.rows.length; i += CHUNK) {
        await tx.productOriginalRow.createMany({
          data: parsed.rows.slice(i, i + CHUNK).map((r) => ({
            id: uuidv4(),
            uploadRunId: uploadId,
            rowNumber: r.rowNumber,
            data: r.original,
          })),
        });
      }

      for (let i = 0; i < issues.length; i += CHUNK) {
        await tx.productValidationIssue.createMany({
          data: issues.slice(i, i + CHUNK).map((issue) => ({
            id: uuidv4(),
            uploadRunId: uploadId,
            rowNumber: issue.rowNumber,
            handle: issue.handle,
            columnName: issue.column,
            severity: issue.severity,
            issueType: issue.issueType,
            currentValue: issue.currentValue,
            message: issue.message,
            suggestedFix: issue.suggestedFix,
          })),
        });
      }
    },
    // Large uploads need far more than the 5s interactive-transaction default.
    { timeout: 120_000, maxWait: 10_000 },
  );

  return {
    uploadId,
    fileName,
    productCount: parsed.groups.length,
    rowCount: parsed.rows.length,
    headers: parsed.headers,
    precheckErrors: issues.length,
    issues,
  };
}

export interface UploadDetail {
  id: string;
  fileName: string;
  productCount: number;
  rowCount: number;
  // null = uploaded before the product pre-check existed (never checked).
  precheckErrors: number | null;
  issues: ProductValidationIssue[];
  ticketNumber: string | null;
  ticketName: string | null;
  comments: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function getUploadRun(uploadId: string): Promise<UploadDetail | null> {
  const upload = await prisma.productUploadRun.findUnique({
    where: { id: uploadId },
    include: {
      _count: { select: { originalRows: true } },
      validationIssues: { orderBy: [{ rowNumber: 'asc' }, { issueType: 'asc' }] },
    },
  });
  if (!upload) return null;
  return {
    id: upload.id,
    fileName: upload.fileName,
    productCount: upload.productCount,
    rowCount: upload._count.originalRows,
    precheckErrors: upload.precheckErrors,
    issues: upload.validationIssues.map(toApiIssue),
    ticketNumber: upload.ticketNumber,
    ticketName: upload.ticketName,
    comments: upload.comments,
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
  };
}

// Pull the most recent import per upload so History can flag "imported" + outcome.
const lastImportSelect = {
  orderBy: { createdAt: 'desc' },
  take: 1,
  select: { status: true, successCount: true, errorCount: true, createdAt: true },
} as const;

/**
 * Twin of getValidationHistory — same view-not-permission rule, same reason.
 * See the comment there.
 *
 * This one additionally had NO `take` at all: it returned every product upload
 * ever made, by anyone. Fine for one user and a handful of runs; an unbounded
 * query against a shared database that only grows.
 */
export async function getUploadHistory(
  query: HistoryQuery = {},
): Promise<ProductHistoryItem[]> {
  const uploads = await prisma.productUploadRun.findMany({
    // Case-insensitive: rows store the display form ("Josh") and the filter
    // supplies the lowercased key. See actorKey() in services/actionLog.service.
    where: query.createdBy
      ? { createdBy: { equals: query.createdBy, mode: 'insensitive' } }
      : undefined,
    orderBy: { createdAt: 'desc' },
    take: clampHistoryLimit(query.limit),
    select: {
      id: true,
      createdBy: true,
      piiPurgedAt: true,
      fileName: true,
      productCount: true,
      precheckErrors: true,
      ticketNumber: true,
      ticketName: true,
      comments: true,
      createdAt: true,
      updatedAt: true,
      importRuns: lastImportSelect,
    },
  });
  return uploads.map(({ importRuns, ...upload }) => ({
    ...upload,
    lastImport: importRuns[0] ?? null,
  }));
}

export async function updateUploadMetadata(
  uploadId: string,
  data: UpdateUploadMetadata,
): Promise<ProductHistoryItem | null> {
  const exists = await prisma.productUploadRun.findUnique({ where: { id: uploadId } });
  if (!exists) return null;
  const upload = await prisma.productUploadRun.update({
    where: { id: uploadId },
    data,
    select: {
      id: true,
      createdBy: true,
      piiPurgedAt: true,
      fileName: true,
      productCount: true,
      precheckErrors: true,
      ticketNumber: true,
      ticketName: true,
      comments: true,
      createdAt: true,
      updatedAt: true,
      importRuns: lastImportSelect,
    },
  });
  const { importRuns, ...rest } = upload;
  return { ...rest, lastImport: importRuns[0] ?? null };
}

export async function deleteUploadRun(uploadId: string): Promise<boolean> {
  const exists = await prisma.productUploadRun.findUnique({ where: { id: uploadId } });
  if (!exists) return false;
  // Cascades to originalRows, importRuns, their results + batch jobs.
  await prisma.productUploadRun.delete({ where: { id: uploadId } });
  return true;
}
