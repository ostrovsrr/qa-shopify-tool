import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import {
  AffectedRow,
  CustomerCsvRow,
  CustomerValidationIssue,
  CustomerValidationResult,
  Severity,
  UpdateValidationMetadata,
  ValidationHistoryItem,
} from '../types';
import { customerValidationRules } from '../validators/customer';
import prisma from '../db/prisma';
import { CsvParseError } from '../errors';
import { applyMappingToRecord, assertValidColumnMapping } from './columnMapping.service';
import { parseCsvFile } from './csvParser.service';
import { deletePreview, getPreview } from './previewStore';

function applyColumnMapping(
  rows: CustomerCsvRow[],
  mapping: Record<string, string>,
): CustomerCsvRow[] {
  if (Object.keys(mapping).length === 0) return rows;
  return rows.map((row) => ({
    ...row,
    original: applyMappingToRecord(row.original, mapping),
    normalized: applyMappingToRecord(row.normalized, mapping),
  }));
}

export async function validateCustomerCsv(
  filePath: string,
  fileName: string,
  columnMapping: Record<string, string> = {},
  heliosMigratedTag = false,
  moveDuplicatesToNotes = false,
  mergeMatchingDuplicates = false,
  // Display + audit only. NEVER a filter on who may see this run.
  createdBy?: string,
): Promise<CustomerValidationResult> {
  const { rows: rawRows, headers } = await parseCsvFile(filePath);
  if (rawRows.length === 0) {
    throw new CsvParseError('The file contains a header row but no customer data rows.');
  }

  // Apply mapping only to the rows fed into validators; raw data is preserved separately
  const rows = applyColumnMapping(rawRows, columnMapping);

  const allIssues: CustomerValidationIssue[] = [];
  for (const rule of customerValidationRules) {
    // Append per-issue rather than spreading (push(...arr)) — the spread passes
    // every element as a function argument and overflows the engine's argument
    // limit ("Maximum call stack size exceeded") when a rule flags many rows.
    for (const issue of rule.validate(rows)) {
      allIssues.push(issue);
    }
  }

  const errors = allIssues.filter((i) => i.severity === 'Error').length;
  const warnings = allIssues.filter((i) => i.severity === 'Warning').length;
  const info = allIssues.filter((i) => i.severity === 'Info').length;

  const affectedRowNumbers = new Set(allIssues.map((i) => i.rowNumber));
  const affectedRows: AffectedRow[] = rows
    .filter((r) => affectedRowNumbers.has(r.rowNumber))
    .map((r) => ({ rowNumber: r.rowNumber, data: r.original }));

  const validationId = uuidv4();

  // Persist the run scalar-first, then chunk the issue/row inserts: a single
  // nested create serializes every issue and original row into one giant query
  // (hundreds of MB of parameters on large files) and can blow the memory or
  // the statement limits. Same pattern as the import-result persistence.
  const CHUNK = 5000;
  await prisma.$transaction(
    async (tx) => {
      await tx.validationRun.create({
        data: {
          id: validationId,
          createdBy: createdBy ?? null,
          fileName,
          fileType: 'CUSTOMER',
          totalRows: rawRows.length,
          errors,
          warnings,
          info,
          affectedRows: affectedRows as unknown as object[],
          originalColumns: headers,
          columnMapping: Object.keys(columnMapping).length > 0
            ? (columnMapping as unknown as object)
            : undefined,
          heliosMigratedTag,
          moveDuplicatesToNotes,
          mergeMatchingDuplicates,
        },
      });

      for (let i = 0; i < allIssues.length; i += CHUNK) {
        await tx.validationIssue.createMany({
          data: allIssues.slice(i, i + CHUNK).map((issue) => ({
            id: uuidv4(),
            validationRunId: validationId,
            rowNumber: issue.rowNumber,
            columnName: issue.column,
            severity: issue.severity,
            issueType: issue.issueType,
            currentValue: issue.currentValue || null,
            message: issue.message,
            suggestedFix: issue.suggestedFix || null,
          })),
        });
      }

      for (let i = 0; i < rawRows.length; i += CHUNK) {
        await tx.originalCustomerRow.createMany({
          data: rawRows.slice(i, i + CHUNK).map((row) => ({
            id: uuidv4(),
            validationRunId: validationId,
            rowNumber: row.rowNumber,
            data: row.original as unknown as object,
          })),
        });
      }
    },
    // Large runs need far more than the 5s interactive-transaction default.
    { timeout: 120_000, maxWait: 10_000 },
  );

  return {
    validationId,
    fileName,
    totalRows: rawRows.length,
    errors,
    warnings,
    info,
    issues: allIssues,
  };
}

export async function validateFromPreview(
  uploadId: string,
  columnMapping: Record<string, string>,
  heliosMigratedTag = false,
  moveDuplicatesToNotes = false,
  mergeMatchingDuplicates = false,
  createdBy?: string,
): Promise<CustomerValidationResult | null> {
  const entry = getPreview(uploadId);
  if (!entry) return null;
  assertValidColumnMapping(entry.headers, columnMapping);
  const result = await validateCustomerCsv(
    entry.filePath,
    entry.fileName,
    columnMapping,
    heliosMigratedTag,
    moveDuplicatesToNotes,
    mergeMatchingDuplicates,
    createdBy,
  );
  // The validate step consumed the preview — delete it, which unlinks the temp
  // file, rather than leaving merchant PII on disk until the TTL. The UI never
  // re-validates the same preview: going back starts a new upload.
  deletePreview(uploadId);
  return result;
}

export async function getValidationResult(
  validationId: string,
): Promise<CustomerValidationResult | null> {
  const run = await prisma.validationRun.findUnique({
    where: { id: validationId },
    include: { issues: { orderBy: { rowNumber: 'asc' } } },
  });

  if (!run) return null;

  return {
    validationId: run.id,
    fileName: run.fileName,
    totalRows: run.totalRows,
    errors: run.errors,
    warnings: run.warnings,
    info: run.info,
    issues: run.issues.map((issue) => ({
      rowNumber: issue.rowNumber,
      column: issue.columnName,
      severity: issue.severity as Severity,
      issueType: issue.issueType,
      currentValue: issue.currentValue ?? '',
      message: issue.message,
      suggestedFix: issue.suggestedFix ?? '',
    })),
  };
}

export async function getValidationHistory(): Promise<ValidationHistoryItem[]> {
  const runs = await prisma.validationRun.findMany({
    select: {
      id: true,
      createdBy: true,
      piiPurgedAt: true,
      fileName: true,
      fileType: true,
      totalRows: true,
      errors: true,
      warnings: true,
      info: true,
      ticketNumber: true,
      ticketName: true,
      comments: true,
      createdAt: true,
      updatedAt: true,
      // Most recent import for this run, so History can flag "imported" + outcome.
      importRuns: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          status: true,
          successCount: true,
          errorCount: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return runs.map(({ importRuns, ...run }) => ({
    ...run,
    lastImport: importRuns[0] ?? null,
  }));
}

export async function updateValidationMetadata(
  validationId: string,
  metadata: UpdateValidationMetadata,
): Promise<ValidationHistoryItem | null> {
  try {
    const run = await prisma.validationRun.update({
      where: { id: validationId },
      data: {
        // undefined means "leave unchanged"; null means "clear it".
        ticketNumber: metadata.ticketNumber,
        ticketName: metadata.ticketName,
        comments: metadata.comments,
      },
      select: {
        id: true,
        createdBy: true,
        piiPurgedAt: true,
        fileName: true,
        fileType: true,
        totalRows: true,
        errors: true,
        warnings: true,
        info: true,
        ticketNumber: true,
        ticketName: true,
        comments: true,
        createdAt: true,
        updatedAt: true,
        importRuns: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            status: true,
            successCount: true,
            errorCount: true,
            createdAt: true,
          },
        },
      },
    });
    const { importRuns, ...rest } = run;
    return { ...rest, lastImport: importRuns[0] ?? null };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return null;
    }
    throw err;
  }
}

export async function deleteValidationRun(validationId: string): Promise<boolean> {
  try {
    await prisma.validationRun.delete({ where: { id: validationId } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return false;
    }
    throw err;
  }
}
