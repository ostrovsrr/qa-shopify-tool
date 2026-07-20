import { Writable } from 'stream';
import ExcelJS from 'exceljs';
import prisma from '../db/prisma';
import {
  applyMappingToRecord,
  KEEP_COLUMN,
  resolveMappingTarget,
  SHOPIFY_COLUMNS,
} from '../services/columnMapping.service';
import { CustomerValidationIssue, Severity } from '../types';
import { excelSafeRecord, excelSafeText } from './excelCell';

// Written with ExcelJS's *streaming* workbook writer: every row is committed
// (flushed to the output stream and freed) as it's built. This report has five
// sheets, three of which repeat every uploaded row (Rows With Shopify Result,
// Full Uploaded File, Shopify Template), so on a large import the in-memory
// workbook plus the writeBuffer copy would exhaust the V8 heap. Streaming keeps
// memory roughly flat regardless of row count.

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

// Streams the workbook to `stream`. `onReady(sourceFileName)` fires once, after
// the DB read and before any bytes are written, so the caller can set the
// Content-Disposition filename before the stream starts.
export async function streamShopifyVerificationReport(
  importRunId: string,
  stream: Writable,
  onReady: (sourceFileName: string) => void,
): Promise<void> {
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

  onReady(validationRun.fileName);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    // Inline strings — a shared-strings table would accumulate every distinct
    // string in memory, defeating the point of streaming.
    useSharedStrings: false,
  });
  workbook.creator = 'Shopify CSV QA Tool';
  workbook.created = new Date();

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

  await workbook.commit();
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

function addResultSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
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
    header: excelSafeText(col),
    key: col,
    width: col === 'Shopify Message' || col.startsWith('Pre-check') ? 42 : 22,
  }));
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(columns.length)}1` };
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
    const row = sheet.addRow(excelSafeRecord(rowData));
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
    row.commit();
  }

  sheet.commit();
}

function addRuleGapsSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, rowResults: ReportRowResult[]) {
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
    sheet.addRow(excelSafeRecord({
      field: group.field,
      code: group.code,
      count: group.rows.length,
      rows: group.rows.join(', '),
      message: group.messages[0] ?? '',
    }));
  }

  sheet.commit();
}

function addRowsWithShopifyResultSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
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
    header: excelSafeText(col),
    key: col,
    width: col === 'Shopify Message' || col.startsWith('Pre-check') ? 42 : 22,
  }));
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(columns.length)}1` };
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
    const row = sheet.addRow(excelSafeRecord(rowData));
    if (result) {
      row.getCell(2).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: result.accepted ? RESULT_COLOURS.accepted : RESULT_COLOURS.rejected },
      };
    }
    row.commit();
  }

  sheet.commit();
}

function addFullUploadedFileSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  originalColumns: string[],
  originalRows: OriginalRow[],
) {
  const sheet = workbook.addWorksheet('Full Uploaded File');

  if (originalColumns.length === 0 || originalRows.length === 0) {
    sheet.addRow(['No uploaded file data available.']);
    sheet.commit();
    return;
  }

  const allColumns = ['Row Number', ...originalColumns];
  sheet.columns = allColumns.map((col) => ({
    header: excelSafeText(col),
    key: col,
    width: col === 'Row Number' ? 12 : 22,
  }));
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(allColumns.length)}1` };
  styleHeader(sheet.getRow(1), HEADER_COLOURS['Full Uploaded File']);

  for (const origRow of originalRows) {
    const data = origRow.data as Record<string, string>;
    const rowData: Record<string, string | number> = { 'Row Number': origRow.rowNumber };
    for (const col of originalColumns) rowData[col] = data[col] ?? '';
    sheet.addRow(excelSafeRecord(rowData)).commit();
  }

  sheet.commit();
}

function addShopifyTemplateSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  columnMapping: Record<string, string>,
  originalRows: OriginalRow[],
  rowResults: ReportRowResult[],
) {
  const sheet = workbook.addWorksheet('Shopify Template');

  if (Object.keys(columnMapping).length === 0 || originalRows.length === 0) {
    sheet.addRow(['No column mapping was applied for this validation run.']);
    sheet.commit();
    return;
  }

  // Append targets ("Add to Tags"/"Add to Note") count as Tags/Note.
  const mappedTargets = new Set(Object.values(columnMapping).map(resolveMappingTarget));
  const baseColumns = SHOPIFY_COLUMNS.filter((col) => mappedTargets.has(col));

  // "Keep" columns pass through as trailing columns under their original names
  const keptColumns = Object.entries(columnMapping)
    .filter(([, tgt]) => tgt === KEEP_COLUMN)
    .map(([src]) => src)
    .filter((src) => !baseColumns.includes(src as (typeof baseColumns)[number]));
  const shopifyColumns: string[] = [...baseColumns, ...keptColumns];

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
    header: excelSafeText(col),
    key: col,
    width: col === 'Shopify Message' ? 42 : 24,
  }));
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(columns.length)}1` };
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
    // Only mapped source columns contribute values; unmapped columns are ignored
    const mappedSources: Record<string, string> = {};
    for (const src of Object.keys(columnMapping)) mappedSources[src] = data[src] ?? '';
    const mapped = applyMappingToRecord(mappedSources, columnMapping);

    for (const shopifyCol of shopifyColumns) {
      rowData[shopifyCol] = mapped[shopifyCol] ?? '';
    }
    sheet.addRow(excelSafeRecord(rowData)).commit();
  }

  sheet.commit();
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
