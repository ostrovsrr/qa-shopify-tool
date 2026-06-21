import ExcelJS from 'exceljs';
import prisma from '../db/prisma';
import { SHOPIFY_COLUMNS } from '../services/columnMapping.service';
import { CustomerValidationIssue, Severity } from '../types';

const HEADER_COLOURS: Record<string, string> = {
  Summary: 'FF1E3A5F',
  Errors: 'FFB91C1C',
  Warnings: 'FFB45309',
  Info: 'FF0369A1',
  'Rule Gaps': 'FF7C3AED',
  'Rows With Shopify Result': 'FF065F46',
  'Full Uploaded File': 'FF065F46',
  'Shopify Template': 'FF004C3F',
};

const RESULT_COLOURS = {
  accepted: 'FFD1FAE5',
  rejected: 'FFFEE2E2',
  falsePositive: 'FFFEF3C7',
  missingRule: 'FFFFE4E6',
};

interface OriginalRow {
  rowNumber: number;
  data: unknown;
}

interface ReportRowResult {
  rowNumber: number;
  accepted: boolean;
  shopifyCustomerId: string | null;
  shopifyCode: string | null;
  shopifyField: string | null;
  message: string | null;
  wasFlaggedByValidator: boolean;
}

export async function generateShopifyVerificationReport(importRunId: string): Promise<Buffer> {
  const importRun = await prisma.importRun.findUnique({
    where: { id: importRunId },
    include: {
      rowResults: { orderBy: { rowNumber: 'asc' } },
      validationRun: {
        include: {
          issues: { orderBy: { rowNumber: 'asc' } },
          originalRows: { orderBy: { rowNumber: 'asc' } },
        },
      },
    },
  });

  if (!importRun) throw new Error(`Import run "${importRunId}" not found.`);

  const validationRun = importRun.validationRun as typeof importRun.validationRun & {
    originalColumns: unknown;
    columnMapping: unknown;
    originalRows: OriginalRow[];
  };

  const originalColumns = Array.isArray(validationRun.originalColumns)
    ? (validationRun.originalColumns as string[])
    : [];
  const columnMapping =
    validationRun.columnMapping &&
    typeof validationRun.columnMapping === 'object' &&
    !Array.isArray(validationRun.columnMapping)
      ? (validationRun.columnMapping as Record<string, string>)
      : {};

  const issues: CustomerValidationIssue[] = validationRun.issues.map((issue) => ({
    rowNumber: issue.rowNumber,
    column: issue.columnName,
    severity: issue.severity as Severity,
    issueType: issue.issueType,
    currentValue: issue.currentValue ?? '',
    message: issue.message,
    suggestedFix: issue.suggestedFix ?? '',
  }));

  const rowResults = importRun.rowResults as ReportRowResult[];
  const issuesByRow = groupIssuesByRow(issues);
  const originalByRow = new Map(
    validationRun.originalRows.map((row) => [row.rowNumber, row.data as Record<string, string>]),
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Shopify CSV QA Tool';
  workbook.created = new Date();

  addSummarySheet(workbook, importRun, validationRun);
  addResultSheet(
    workbook,
    'Errors',
    rowResults.filter((r) => !r.accepted),
    originalColumns,
    originalByRow,
    issuesByRow,
  );
  addResultSheet(
    workbook,
    'Warnings',
    rowResults.filter((r) => r.accepted && r.wasFlaggedByValidator),
    originalColumns,
    originalByRow,
    issuesByRow,
  );
  addInfoSheet(workbook, rowResults, issuesByRow);
  addRuleGapsSheet(workbook, rowResults);
  addRowsWithShopifyResultSheet(
    workbook,
    originalColumns,
    validationRun.originalRows,
    rowResults,
    issuesByRow,
  );
  addFullUploadedFileSheet(workbook, originalColumns, validationRun.originalRows);
  addShopifyTemplateSheet(workbook, columnMapping, validationRun.originalRows, rowResults);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function styleHeader(row: ExcelJS.Row, bgArgb: string) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });
  row.height = 20;
}

function groupIssuesByRow(issues: CustomerValidationIssue[]): Map<number, CustomerValidationIssue[]> {
  const map = new Map<number, CustomerValidationIssue[]>();
  for (const issue of issues) {
    if (!map.has(issue.rowNumber)) map.set(issue.rowNumber, []);
    map.get(issue.rowNumber)!.push(issue);
  }
  return map;
}

function summarizeIssues(issues: CustomerValidationIssue[] | undefined) {
  const list = issues ?? [];
  return {
    errorCount: list.filter((i) => i.severity === 'Error').length,
    warningCount: list.filter((i) => i.severity === 'Warning').length,
    issueTypes: [...new Set(list.map((i) => i.issueType))].join(', '),
    messages: list.map((i) => i.message).join(' | '),
    suggestedFixes: list.map((i) => i.suggestedFix).filter(Boolean).join(' | '),
  };
}

function addSummarySheet(
  workbook: ExcelJS.Workbook,
  importRun: {
    id: string;
    validationId: string;
    shopDomain: string;
    bulkOperationId: string | null;
    status: string;
    successCount: number;
    errorCount: number;
    createdAt: Date;
    rowResults: ReportRowResult[];
  },
  validationRun: {
    fileName: string;
    totalRows: number;
    errors: number;
    warnings: number;
    info: number;
    createdAt: Date;
  },
) {
  const sheet = workbook.addWorksheet('Summary');
  sheet.columns = [{ width: 34 }, { width: 58 }];

  const title = sheet.addRow(['Shopify CSV QA Tool - Shopify Verification Report']);
  title.getCell(1).font = { bold: true, size: 14, color: { argb: HEADER_COLOURS.Summary } };
  sheet.addRow([]);

  const missingRule = importRun.rowResults.filter((r) => !r.accepted && !r.wasFlaggedByValidator).length;
  const falsePositive = importRun.rowResults.filter((r) => r.accepted && r.wasFlaggedByValidator).length;
  const confirmedReject = importRun.rowResults.filter((r) => !r.accepted && r.wasFlaggedByValidator).length;
  const confirmedClean = importRun.rowResults.filter((r) => r.accepted && !r.wasFlaggedByValidator).length;

  const kv = (label: string, value: string | number) => {
    const r = sheet.addRow([label, value]);
    r.getCell(1).font = { bold: true };
  };

  kv('File Name', validationRun.fileName);
  kv('Validation ID', importRun.validationId);
  kv('Import Run ID', importRun.id);
  kv('Shop Domain', importRun.shopDomain);
  kv('Bulk Operation ID', importRun.bulkOperationId ?? '(parallel batch — multiple)');
  kv('Bulk Operation Status', importRun.status);
  kv('Imported At', importRun.createdAt.toISOString());
  sheet.addRow([]);
  kv('Original Total Rows', validationRun.totalRows);
  kv('Pre-check Errors', validationRun.errors);
  kv('Pre-check Warnings', validationRun.warnings);
  kv('Pre-check Info', validationRun.info);
  sheet.addRow([]);
  kv('Shopify Accepted Rows', importRun.successCount);
  kv('Shopify Rejected Rows', importRun.errorCount);
  kv('Missing Rule Rows', missingRule);
  kv('False Positive Rows', falsePositive);
  kv('Confirmed Reject Rows', confirmedReject);
  kv('Confirmed Clean Rows', confirmedClean);

  sheet.addRow([]);
  const header = sheet.addRow(['Bucket', 'Meaning']);
  styleHeader(header, HEADER_COLOURS.Summary);
  sheet.addRows([
    ['Errors', 'Rows Shopify rejected. These are the highest priority fixes.'],
    ['Warnings', 'Rows our pre-check flagged but Shopify accepted. Review for over-strict rules.'],
    ['Info', 'Confirmed reject and confirmed clean row counts.'],
    ['Rows With Shopify Result', 'Full uploaded file plus Shopify status and pre-check issue summary.'],
    ['Shopify Template', 'Mapped Shopify import template plus Shopify result columns.'],
  ]);
}

function addResultSheet(
  workbook: ExcelJS.Workbook,
  sheetName: 'Errors' | 'Warnings',
  results: ReportRowResult[],
  originalColumns: string[],
  originalByRow: Map<number, Record<string, string>>,
  issuesByRow: Map<number, CustomerValidationIssue[]>,
) {
  const sheet = workbook.addWorksheet(sheetName);
  const columns = [
    'Row Number',
    'Shopify Result',
    'Shopify Field',
    'Shopify Code',
    'Shopify Message',
    'Was Flagged By Pre-check',
    'Pre-check Error Count',
    'Pre-check Warning Count',
    'Pre-check Issue Types',
    'Pre-check Messages',
    'Pre-check Suggested Fixes',
    ...originalColumns,
  ];

  sheet.columns = columns.map((col) => ({
    header: col,
    key: col,
    width: col === 'Shopify Message' || col.startsWith('Pre-check') ? 42 : 22,
  }));
  styleHeader(sheet.getRow(1), HEADER_COLOURS[sheetName]);

  for (const result of results) {
    const issueSummary = summarizeIssues(issuesByRow.get(result.rowNumber));
    const original = originalByRow.get(result.rowNumber) ?? {};
    const rowData: Record<string, string | number | boolean> = {
      'Row Number': result.rowNumber,
      'Shopify Result': result.accepted ? 'Accepted' : 'Rejected',
      'Shopify Field': result.shopifyField ?? '',
      'Shopify Code': result.shopifyCode ?? '',
      'Shopify Message': result.message ?? '',
      'Was Flagged By Pre-check': result.wasFlaggedByValidator,
      'Pre-check Error Count': issueSummary.errorCount,
      'Pre-check Warning Count': issueSummary.warningCount,
      'Pre-check Issue Types': issueSummary.issueTypes,
      'Pre-check Messages': issueSummary.messages,
      'Pre-check Suggested Fixes': issueSummary.suggestedFixes,
    };
    for (const col of originalColumns) rowData[col] = original[col] ?? '';
    const row = sheet.addRow(rowData);
    row.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {
          argb: !result.accepted && !result.wasFlaggedByValidator
            ? RESULT_COLOURS.missingRule
            : result.accepted
              ? RESULT_COLOURS.falsePositive
              : RESULT_COLOURS.rejected,
        },
      };
    });
  }

  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(columns.length)}1` };
}

function addInfoSheet(
  workbook: ExcelJS.Workbook,
  rowResults: ReportRowResult[],
  issuesByRow: Map<number, CustomerValidationIssue[]>,
) {
  const sheet = workbook.addWorksheet('Info');
  sheet.columns = [
    { header: 'Bucket', key: 'bucket', width: 24 },
    { header: 'Count', key: 'count', width: 12 },
    { header: 'Rows', key: 'rows', width: 80 },
  ];
  styleHeader(sheet.getRow(1), HEADER_COLOURS.Info);

  const buckets = [
    ['Confirmed Reject', rowResults.filter((r) => !r.accepted && r.wasFlaggedByValidator)],
    ['Confirmed Clean', rowResults.filter((r) => r.accepted && !r.wasFlaggedByValidator)],
    ['Rejected With No Pre-check Error', rowResults.filter((r) => !r.accepted && summarizeIssues(issuesByRow.get(r.rowNumber)).errorCount === 0)],
  ] as const;

  for (const [bucket, rows] of buckets) {
    sheet.addRow({
      bucket,
      count: rows.length,
      rows: rows.map((r) => r.rowNumber).join(', '),
    });
  }
}

function addRuleGapsSheet(workbook: ExcelJS.Workbook, rowResults: ReportRowResult[]) {
  const sheet = workbook.addWorksheet('Rule Gaps');
  sheet.columns = [
    { header: 'Shopify Field', key: 'field', width: 24 },
    { header: 'Shopify Code', key: 'code', width: 18 },
    { header: 'Count', key: 'count', width: 12 },
    { header: 'Rows', key: 'rows', width: 48 },
    { header: 'Sample Message', key: 'message', width: 64 },
  ];
  styleHeader(sheet.getRow(1), HEADER_COLOURS['Rule Gaps']);

  const groups = new Map<string, { field: string; code: string; rows: number[]; messages: string[] }>();
  for (const result of rowResults.filter((r) => !r.accepted && !r.wasFlaggedByValidator)) {
    const key = `${result.shopifyField ?? ''}|${result.shopifyCode ?? ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        field: result.shopifyField ?? '',
        code: result.shopifyCode ?? '',
        rows: [],
        messages: [],
      });
    }
    const group = groups.get(key)!;
    group.rows.push(result.rowNumber);
    if (result.message && !group.messages.includes(result.message)) group.messages.push(result.message);
  }

  for (const group of [...groups.values()].sort((a, b) => b.rows.length - a.rows.length)) {
    sheet.addRow({
      field: group.field,
      code: group.code,
      count: group.rows.length,
      rows: group.rows.join(', '),
      message: group.messages[0] ?? '',
    });
  }
}

function addRowsWithShopifyResultSheet(
  workbook: ExcelJS.Workbook,
  originalColumns: string[],
  originalRows: OriginalRow[],
  rowResults: ReportRowResult[],
  issuesByRow: Map<number, CustomerValidationIssue[]>,
) {
  const sheet = workbook.addWorksheet('Rows With Shopify Result');
  const resultByRow = new Map(rowResults.map((r) => [r.rowNumber, r]));
  const columns = [
    'Row Number',
    'Shopify Result',
    'Shopify Customer ID',
    'Shopify Field',
    'Shopify Code',
    'Shopify Message',
    'Was Flagged By Pre-check',
    'Pre-check Error Count',
    'Pre-check Warning Count',
    'Pre-check Issue Types',
    ...originalColumns,
  ];

  sheet.columns = columns.map((col) => ({
    header: col,
    key: col,
    width: col === 'Shopify Message' || col.startsWith('Pre-check') ? 42 : 22,
  }));
  styleHeader(sheet.getRow(1), HEADER_COLOURS['Rows With Shopify Result']);

  for (const origRow of originalRows) {
    const data = origRow.data as Record<string, string>;
    const result = resultByRow.get(origRow.rowNumber);
    const issueSummary = summarizeIssues(issuesByRow.get(origRow.rowNumber));
    const rowData: Record<string, string | number | boolean> = {
      'Row Number': origRow.rowNumber,
      'Shopify Result': result ? (result.accepted ? 'Accepted' : 'Rejected') : 'Not imported',
      'Shopify Customer ID': result?.shopifyCustomerId ?? '',
      'Shopify Field': result?.shopifyField ?? '',
      'Shopify Code': result?.shopifyCode ?? '',
      'Shopify Message': result?.message ?? '',
      'Was Flagged By Pre-check': result?.wasFlaggedByValidator ?? issuesByRow.has(origRow.rowNumber),
      'Pre-check Error Count': issueSummary.errorCount,
      'Pre-check Warning Count': issueSummary.warningCount,
      'Pre-check Issue Types': issueSummary.issueTypes,
    };
    for (const col of originalColumns) rowData[col] = data[col] ?? '';
    const row = sheet.addRow(rowData);
    if (result) {
      row.getCell(2).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: result.accepted ? RESULT_COLOURS.accepted : RESULT_COLOURS.rejected },
      };
    }
  }

  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(columns.length)}1` };
}

function addFullUploadedFileSheet(
  workbook: ExcelJS.Workbook,
  originalColumns: string[],
  originalRows: OriginalRow[],
) {
  const sheet = workbook.addWorksheet('Full Uploaded File');

  if (originalColumns.length === 0 || originalRows.length === 0) {
    sheet.addRow(['No uploaded file data available.']);
    return;
  }

  const allColumns = ['Row Number', ...originalColumns];
  sheet.columns = allColumns.map((col) => ({
    header: col,
    key: col,
    width: col === 'Row Number' ? 12 : 22,
  }));
  styleHeader(sheet.getRow(1), HEADER_COLOURS['Full Uploaded File']);

  for (const origRow of originalRows) {
    const data = origRow.data as Record<string, string>;
    const rowData: Record<string, string | number> = { 'Row Number': origRow.rowNumber };
    for (const col of originalColumns) rowData[col] = data[col] ?? '';
    sheet.addRow(rowData);
  }

  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(allColumns.length)}1` };
}

function addShopifyTemplateSheet(
  workbook: ExcelJS.Workbook,
  columnMapping: Record<string, string>,
  originalRows: OriginalRow[],
  rowResults: ReportRowResult[],
) {
  const sheet = workbook.addWorksheet('Shopify Template');

  if (Object.keys(columnMapping).length === 0 || originalRows.length === 0) {
    sheet.addRow(['No column mapping was applied for this validation run.']);
    return;
  }

  const mappedTargets = new Set(Object.values(columnMapping));
  const shopifyColumns = SHOPIFY_COLUMNS.filter((col) => mappedTargets.has(col));
  const reverseMap: Record<string, string> = {};
  for (const [src, tgt] of Object.entries(columnMapping)) reverseMap[tgt] = src;

  const resultByRow = new Map(rowResults.map((r) => [r.rowNumber, r]));
  const columns = [
    'Row Number',
    'Shopify Result',
    'Shopify Field',
    'Shopify Code',
    'Shopify Message',
    ...shopifyColumns,
  ];
  sheet.columns = columns.map((col) => ({
    header: col,
    key: col,
    width: col === 'Shopify Message' ? 42 : 24,
  }));
  styleHeader(sheet.getRow(1), HEADER_COLOURS['Shopify Template']);

  for (const origRow of originalRows) {
    const data = origRow.data as Record<string, string>;
    const result = resultByRow.get(origRow.rowNumber);
    const rowData: Record<string, string | number> = {
      'Row Number': origRow.rowNumber,
      'Shopify Result': result ? (result.accepted ? 'Accepted' : 'Rejected') : 'Not imported',
      'Shopify Field': result?.shopifyField ?? '',
      'Shopify Code': result?.shopifyCode ?? '',
      'Shopify Message': result?.message ?? '',
    };
    for (const shopifyCol of shopifyColumns) {
      const srcCol = reverseMap[shopifyCol];
      rowData[shopifyCol] = srcCol !== undefined ? (data[srcCol] ?? '') : '';
    }
    sheet.addRow(rowData);
  }

  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(columns.length)}1` };
}

function columnIndexToLetter(index: number): string {
  let letter = '';
  while (index > 0) {
    const remainder = (index - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    index = Math.floor((index - 1) / 26);
  }
  return letter;
}
