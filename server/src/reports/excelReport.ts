import ExcelJS from 'exceljs';
import prisma from '../db/prisma';
import { AffectedRow, CustomerValidationIssue, Severity } from '../types';

// Severity → background colour (ARGB)
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
  'Original Rows With Issues': 'FF4C1D95',
};

export async function generateExcelReport(validationId: string): Promise<Buffer> {
  const run = await prisma.validationRun.findUnique({
    where: { id: validationId },
    include: { issues: { orderBy: { rowNumber: 'asc' } } },
  });

  if (!run) throw new Error(`Validation run "${validationId}" not found.`);

  const issues: CustomerValidationIssue[] = run.issues.map((issue) => ({
    rowNumber: issue.rowNumber,
    column: issue.columnName,
    severity: issue.severity as Severity,
    issueType: issue.issueType,
    currentValue: issue.currentValue ?? '',
    message: issue.message,
    suggestedFix: issue.suggestedFix ?? '',
  }));

  const affectedRows: AffectedRow[] = Array.isArray(run.affectedRows)
    ? (run.affectedRows as unknown as AffectedRow[])
    : [];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Shopify CSV QA Tool';
  workbook.created = new Date();

  addSummarySheet(workbook, run, issues);
  addIssuesSheet(workbook, 'Errors', issues.filter((i) => i.severity === 'Error'));
  addIssuesSheet(workbook, 'Warnings', issues.filter((i) => i.severity === 'Warning'));
  addIssuesSheet(workbook, 'Info', issues.filter((i) => i.severity === 'Info'));
  addOriginalRowsSheet(workbook, issues, affectedRows);

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

  // Count by issue type
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

function addOriginalRowsSheet(
  workbook: ExcelJS.Workbook,
  issues: CustomerValidationIssue[],
  affectedRows: AffectedRow[],
) {
  const sheet = workbook.addWorksheet('Original Rows With Issues');

  if (affectedRows.length === 0) {
    sheet.addRow(['No original row data available.']);
    return;
  }

  // Derive column set from available data (preserve insertion order from first row)
  const allColumns = ['Row Number', ...Object.keys(affectedRows[0]?.data ?? {})];
  sheet.columns = allColumns.map((col) => ({
    header: col,
    key: col,
    width: col === 'Row Number' ? 12 : 22,
  }));

  styleHeader(sheet.getRow(1), HEADER_COLOURS['Original Rows With Issues']);

  // Build a quick lookup: rowNumber → set of issue types
  const rowIssueTypes = new Map<number, Set<string>>();
  for (const issue of issues) {
    const s = rowIssueTypes.get(issue.rowNumber) ?? new Set();
    s.add(issue.severity);
    rowIssueTypes.set(issue.rowNumber, s);
  }

  const sorted = [...affectedRows].sort((a, b) => a.rowNumber - b.rowNumber);

  for (const affected of sorted) {
    const rowData: Record<string, string | number> = { 'Row Number': affected.rowNumber };
    for (const [col, val] of Object.entries(affected.data)) {
      rowData[col] = val;
    }

    const row = sheet.addRow(rowData);

    // Highlight row if it has errors
    const severities = rowIssueTypes.get(affected.rowNumber) ?? new Set();
    const colour = severities.has('Error')
      ? SEVERITY_COLOURS.Error
      : severities.has('Warning')
        ? SEVERITY_COLOURS.Warning
        : SEVERITY_COLOURS.Info;

    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colour } };
    });
  }

  sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + allColumns.length)}1` };
}
