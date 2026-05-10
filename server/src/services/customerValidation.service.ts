import { v4 as uuidv4 } from 'uuid';
import {
  AffectedRow,
  CustomerValidationIssue,
  CustomerValidationResult,
  Severity,
  ValidationHistoryItem,
} from '../types';
import { customerValidationRules } from '../validators/customer';
import prisma from '../db/prisma';
import { parseCsvBuffer } from './csvParser.service';

export async function validateCustomerCsv(
  buffer: Buffer,
  fileName: string,
): Promise<CustomerValidationResult> {
  const rows = await parseCsvBuffer(buffer);

  // Run every rule and collect all issues
  const allIssues: CustomerValidationIssue[] = [];
  for (const rule of customerValidationRules) {
    allIssues.push(...rule.validate(rows));
  }

  const errors = allIssues.filter((i) => i.severity === 'Error').length;
  const warnings = allIssues.filter((i) => i.severity === 'Warning').length;
  const info = allIssues.filter((i) => i.severity === 'Info').length;

  // Build a map of affected row numbers → original data for the Excel report
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
      totalRows: rows.length,
      errors,
      warnings,
      info,
      affectedRows: affectedRows as unknown as object[],
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
    },
  });

  return {
    validationId,
    fileName,
    totalRows: rows.length,
    errors,
    warnings,
    info,
    issues: allIssues,
  };
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
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return runs;
}

export async function deleteValidationRun(validationId: string): Promise<boolean> {
  try {
    await prisma.validationRun.delete({ where: { id: validationId } });
    return true;
  } catch {
    return false;
  }
}
