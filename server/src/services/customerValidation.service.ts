import { v4 as uuidv4 } from 'uuid';
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
import { parseCsvBuffer } from './csvParser.service';
import { getPreview } from './previewStore';

function applyColumnMapping(
  rows: CustomerCsvRow[],
  mapping: Record<string, string>,
): CustomerCsvRow[] {
  if (Object.keys(mapping).length === 0) return rows;
  return rows.map((row) => {
    const newOriginal: Record<string, string> = {};
    const newNormalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.original)) {
      const mapped = mapping[key] ?? key;
      newOriginal[mapped] = value;
    }
    for (const [key, value] of Object.entries(row.normalized)) {
      const mapped = mapping[key] ?? key;
      newNormalized[mapped] = value;
    }
    return { ...row, original: newOriginal, normalized: newNormalized };
  });
}

export async function validateCustomerCsv(
  buffer: Buffer,
  fileName: string,
  columnMapping: Record<string, string> = {},
  heliosMigratedTag = false,
): Promise<CustomerValidationResult> {
  const { rows: rawRows, headers } = await parseCsvBuffer(buffer);

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

  await prisma.validationRun.create({
    data: {
      id: validationId,
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
      issues: {
        create: allIssues.map((issue) => ({
          id: uuidv4(),
          rowNumber: issue.rowNumber,
          columnName: issue.column,
          severity: issue.severity,
          issueType: issue.issueType,
          currentValue: issue.currentValue || null,
          message: issue.message,
          suggestedFix: issue.suggestedFix || null,
        })),
      },
      originalRows: {
        create: rawRows.map((row) => ({
          id: uuidv4(),
          rowNumber: row.rowNumber,
          data: row.original as unknown as object,
        })),
      },
    },
  });

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
): Promise<CustomerValidationResult | null> {
  const entry = getPreview(uploadId);
  if (!entry) return null;
  return validateCustomerCsv(entry.buffer, entry.fileName, columnMapping, heliosMigratedTag);
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
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return runs;
}

export async function updateValidationMetadata(
  validationId: string,
  metadata: UpdateValidationMetadata,
): Promise<ValidationHistoryItem | null> {
  try {
    const run = await prisma.validationRun.update({
      where: { id: validationId },
      data: {
        ticketNumber: metadata.ticketNumber ?? undefined,
        ticketName: metadata.ticketName ?? undefined,
        comments: metadata.comments ?? undefined,
      },
      select: {
        id: true,
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
      },
    });
    return run;
  } catch {
    return null;
  }
}

export async function deleteValidationRun(validationId: string): Promise<boolean> {
  try {
    await prisma.validationRun.delete({ where: { id: validationId } });
    return true;
  } catch {
    return false;
  }
}
