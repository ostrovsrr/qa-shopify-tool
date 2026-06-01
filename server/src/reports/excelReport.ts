import ExcelJS from 'exceljs';
import prisma from '../db/prisma';
import { SHOPIFY_COLUMNS } from '../services/columnMapping.service';
import { CustomerValidationIssue, Severity } from '../types';
import { AutoFixEntry, computeAutoFixes } from './autoFix';

const SEVERITY_COLOURS: Record<Severity, string> = {
  Error: 'FFFEE2E2',
  Warning: 'FFFEF3C7',
  Info: 'FFE0F2FE',
};

const HEADER_COLOURS: Record<string, string> = {
  Summary: 'FF1E3A5F',
  Errors: 'FFB91C1C',
  Warnings: 'FFB45309',
  Info: 'FF0369A1',
  'Full Uploaded File': 'FF065F46',
  'Shopify Template': 'FF004C3F',
};

export async function generateExcelReport(validationId: string): Promise<Buffer> {
  const run = await prisma.validationRun.findUnique({
    where: { id: validationId },
    include: {
      issues: { orderBy: { rowNumber: 'asc' } },
      originalRows: { orderBy: { rowNumber: 'asc' } },
    },
  });

  if (!run) throw new Error(`Validation run "${validationId}" not found.`);

  // Cast to include JSON fields that Prisma's stale generated types don't yet expose
  const runData = run as typeof run & {
    originalColumns: unknown;
    columnMapping: unknown;
    heliosMigratedTag: boolean;
    originalRows: { rowNumber: number; data: unknown }[];
  };

  const issues: CustomerValidationIssue[] = run.issues.map((issue) => ({
    rowNumber: issue.rowNumber,
    column: issue.columnName,
    severity: issue.severity as Severity,
    issueType: issue.issueType,
    currentValue: issue.currentValue ?? '',
    message: issue.message,
    suggestedFix: issue.suggestedFix ?? '',
  }));

  const originalColumns: string[] = Array.isArray(runData.originalColumns)
    ? (runData.originalColumns as string[])
    : [];

  const columnMapping: Record<string, string> =
    runData.columnMapping &&
    typeof runData.columnMapping === 'object' &&
    !Array.isArray(runData.columnMapping)
      ? (runData.columnMapping as Record<string, string>)
      : {};

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Shopify CSV QA Tool';
  workbook.created = new Date();

  const autoFixes = computeAutoFixes(runData.originalRows, columnMapping);
  const heliosMigratedTag: boolean = runData.heliosMigratedTag ?? false;

  addSummarySheet(workbook, run, issues);
  addIssuesSheet(workbook, 'Errors', issues.filter((i) => i.severity === 'Error'));
  addIssuesSheet(workbook, 'Warnings', issues.filter((i) => i.severity === 'Warning'));
  addFullUploadedFileSheet(workbook, originalColumns, runData.originalRows);
  addShopifyTemplateSheet(workbook, columnMapping, runData.originalRows, autoFixes, heliosMigratedTag);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------------------------------------------------------------------------

function styleHeader(row: ExcelJS.Row, bgArgb: string) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });
  row.height = 20;
}

function addSummarySheet(
  workbook: ExcelJS.Workbook,
  run: {
    id: string;
    fileName: string;
    totalRows: number;
    errors: number;
    warnings: number;
    info: number;
    createdAt: Date;
  },
  issues: CustomerValidationIssue[],
) {
  const sheet = workbook.addWorksheet('Summary');
  sheet.columns = [{ width: 28 }, { width: 44 }];

  const title = sheet.addRow(['Shopify CSV QA Tool — Validation Report']);
  title.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
  sheet.addRow([]);

  const kv = (label: string, value: string | number) => {
    const r = sheet.addRow([label, value]);
    r.getCell(1).font = { bold: true };
  };

  kv('File Name', run.fileName);
  kv('Validation ID', run.id);
  kv('Total Rows', run.totalRows);
  kv('Total Errors', run.errors);
  kv('Total Warnings', run.warnings);
  kv('Total Info', run.info);
  kv('Created Date', run.createdAt.toISOString());
  sheet.addRow([]);

  const breakdownTitle = sheet.addRow(['Issue Type Breakdown']);
  breakdownTitle.getCell(1).font = { bold: true, size: 12 };

  const headerRow = sheet.addRow(['Issue Type', 'Count', 'Severity']);
  styleHeader(headerRow, HEADER_COLOURS['Summary']);
  sheet.getColumn(3).width = 14;

  const counts = new Map<string, { count: number; severity: Severity }>();
  for (const issue of issues) {
    const existing = counts.get(issue.issueType);
    if (existing) {
      existing.count++;
    } else {
      counts.set(issue.issueType, { count: 1, severity: issue.severity });
    }
  }

  for (const [issueType, { count, severity }] of [...counts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const r = sheet.addRow([issueType, count, severity]);
    r.getCell(3).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: SEVERITY_COLOURS[severity] },
    };
  }
}

function addIssuesSheet(
  workbook: ExcelJS.Workbook,
  sheetName: 'Errors' | 'Warnings' | 'Info',
  issues: CustomerValidationIssue[],
) {
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = [
    { header: 'Row Number', key: 'rowNumber', width: 12 },
    { header: 'Column', key: 'column', width: 26 },
    { header: 'Severity', key: 'severity', width: 12 },
    { header: 'Issue Type', key: 'issueType', width: 30 },
    { header: 'Current Value', key: 'currentValue', width: 32 },
    { header: 'Message', key: 'message', width: 55 },
    { header: 'Suggested Fix', key: 'suggestedFix', width: 55 },
  ];

  styleHeader(sheet.getRow(1), HEADER_COLOURS[sheetName]);

  for (const issue of issues) {
    const row = sheet.addRow({
      rowNumber: issue.rowNumber,
      column: issue.column,
      severity: issue.severity,
      issueType: issue.issueType,
      currentValue: issue.currentValue,
      message: issue.message,
      suggestedFix: issue.suggestedFix,
    });
    const colour = SEVERITY_COLOURS[issue.severity];
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colour } };
    });
  }

  sheet.autoFilter = { from: 'A1', to: 'G1' };
}

function addFullUploadedFileSheet(
  workbook: ExcelJS.Workbook,
  originalColumns: string[],
  originalRows: { rowNumber: number; data: unknown }[],
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
    for (const col of originalColumns) {
      rowData[col] = data[col] ?? '';
    }
    sheet.addRow(rowData);
  }

  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(allColumns.length)}1` };
}

const AUTO_FIX_GREEN = 'FFD1FAE5';

const HELIOS_TAG = 'HeliosMigrated';

function addShopifyTemplateSheet(
  workbook: ExcelJS.Workbook,
  columnMapping: Record<string, string>,
  originalRows: { rowNumber: number; data: unknown }[],
  autoFixes: AutoFixEntry[] = [],
  heliosMigratedTag = false,
) {
  const sheet = workbook.addWorksheet('Shopify Template');

  if (Object.keys(columnMapping).length === 0 || originalRows.length === 0) {
    sheet.addRow(['No column mapping was applied for this validation run.']);
    return;
  }

  // Determine which Shopify columns are present, in canonical SHOPIFY_COLUMNS order
  const mappedTargets = new Set(Object.values(columnMapping));
  const shopifyColumns = SHOPIFY_COLUMNS.filter((col) => mappedTargets.has(col));

  // If appending HeliosMigrated tag and Tags isn't already mapped, add it as a trailing column
  const tagsAlreadyMapped = shopifyColumns.includes('Tags');
  const effectiveColumns: string[] =
    heliosMigratedTag && !tagsAlreadyMapped ? [...shopifyColumns, 'Tags'] : [...shopifyColumns];

  // Build reverse map: Shopify column → source CSV column(s)
  // (multiple source columns can map to the same target — last one wins)
  const reverseMap: Record<string, string> = {};
  for (const [src, tgt] of Object.entries(columnMapping)) {
    reverseMap[tgt] = src;
  }

  // Row Number is always the first column
  sheet.columns = [
    { header: 'Row Number', key: 'rowNumber', width: 12 },
    ...effectiveColumns.map((col) => ({ header: col, key: col, width: 26 })),
  ];

  styleHeader(sheet.getRow(1), HEADER_COLOURS['Shopify Template']);

  // Build fix lookup: rowNumber → shopify column → fixed value
  const fixMap = new Map<number, Map<string, string>>();
  for (const fix of autoFixes) {
    if (!fixMap.has(fix.rowNumber)) fixMap.set(fix.rowNumber, new Map());
    fixMap.get(fix.rowNumber)!.set(fix.field, fix.fixedValue);
  }

  for (const origRow of originalRows) {
    const data = origRow.data as Record<string, string>;
    const rowFixes = fixMap.get(origRow.rowNumber);
    const rowData: Record<string, string | number> = { rowNumber: origRow.rowNumber };

    for (const shopifyCol of effectiveColumns) {
      const srcCol = reverseMap[shopifyCol];
      rowData[shopifyCol] = rowFixes?.get(shopifyCol) ?? (srcCol !== undefined ? (data[srcCol] ?? '') : '');
    }

    if (heliosMigratedTag) {
      const existing = rowData['Tags'] as string ?? '';
      rowData['Tags'] = existing ? `${existing},${HELIOS_TAG}` : HELIOS_TAG;
    }

    const excelRow = sheet.addRow(rowData);

    if (rowFixes) {
      effectiveColumns.forEach((shopifyCol, colIdx) => {
        if (rowFixes.has(shopifyCol)) {
          // +2 because col index 1 is Row Number
          const cell = excelRow.getCell(colIdx + 2);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AUTO_FIX_GREEN } };
        }
      });
    }
  }

  // +1 for the Row Number column
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(effectiveColumns.length + 1)}1` };
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
