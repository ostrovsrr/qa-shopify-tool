import { Writable } from 'stream';
import ExcelJS from 'exceljs';
import prisma from '../db/prisma';
import { HttpError } from '../errors';
import { purgedMessage } from '../services/retention.service';
import {
  KEEP_COLUMN,
  resolveMappingTarget,
  SHOPIFY_COLUMNS,
} from '../services/columnMapping.service';
import { CustomerValidationIssue, Severity } from '../types';
import { AutoFixEntry, computeAutoFixes } from './autoFix';
import { excelSafeRecord, excelSafeText } from './excelCell';
import { buildTemplateDataset } from './templateDataset';

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

// The report is written with ExcelJS's *streaming* workbook writer: each row is
// committed (flushed to the output stream and freed) as it's built, so the whole
// workbook is never held in memory at once. This is what keeps a 160k+ row report
// from exhausting the V8 heap. `onReady(fileName)` fires once, after the DB read
// and before any bytes are written, so the caller can set response headers
// (Content-Disposition) before the stream starts.
export async function streamExcelReport(
  validationId: string,
  stream: Writable,
  onReady: (sourceFileName: string) => void,
): Promise<void> {
  const run = await prisma.validationRun.findUnique({
    where: { id: validationId },
    include: {
      issues: { orderBy: { rowNumber: 'asc' } },
      originalRows: { orderBy: { rowNumber: 'asc' } },
    },
  });

  if (!run) throw new Error(`Validation run "${validationId}" not found.`);

  // The raw rows this report is built FROM were purged for retention (D13). Say so
  // — a 410 with a sentence beats a workbook full of blanks or a 500 that reads
  // like a bug the user should report.
  if (run.piiPurgedAt) throw new HttpError(410, purgedMessage(run.piiPurgedAt));

  // Cast to include JSON fields that Prisma's stale generated types don't yet expose
  const runData = run as typeof run & {
    originalColumns: unknown;
    columnMapping: unknown;
    heliosMigratedTag: boolean;
    moveDuplicatesToNotes: boolean;
    mergeMatchingDuplicates: boolean;
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

  const autoFixes = computeAutoFixes(runData.originalRows, columnMapping);
  const heliosMigratedTag: boolean = runData.heliosMigratedTag ?? false;
  const moveDuplicatesToNotes: boolean = runData.moveDuplicatesToNotes ?? false;
  const mergeMatchingDuplicates: boolean = runData.mergeMatchingDuplicates ?? false;

  // Headers must be set before the workbook writes its first byte.
  onReady(run.fileName);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    // Inline strings — a shared-strings table would accumulate every distinct
    // string in memory, defeating the point of streaming.
    useSharedStrings: false,
  });
  workbook.creator = 'Shopify CSV QA Tool';
  workbook.created = new Date();

  addSummarySheet(workbook, run, issues);
  addIssuesSheet(workbook, 'Errors', issues.filter((i) => i.severity === 'Error'));
  addIssuesSheet(workbook, 'Warnings', issues.filter((i) => i.severity === 'Warning'));
  addFullUploadedFileSheet(workbook, originalColumns, runData.originalRows);
  addShopifyTemplateSheet(
    workbook,
    columnMapping,
    runData.originalRows,
    autoFixes,
    heliosMigratedTag,
    moveDuplicatesToNotes,
    issues,
    mergeMatchingDuplicates,
  );

  await workbook.commit();
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
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
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

  // Summary is small and sets a column width after adding rows (getColumn(3)),
  // so commit the whole sheet at once rather than per row — column metadata is
  // written when the sheet is committed.
  sheet.commit();
}

function addIssuesSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
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

  // autoFilter is serialized when the sheet is committed, so it can be set up front.
  sheet.autoFilter = { from: 'A1', to: 'G1' };
  styleHeader(sheet.getRow(1), HEADER_COLOURS[sheetName]);

  const colour = SEVERITY_COLOURS[sheetName === 'Errors' ? 'Error' : sheetName === 'Warnings' ? 'Warning' : 'Info'];
  for (const issue of issues) {
    const row = sheet.addRow(excelSafeRecord({
      rowNumber: issue.rowNumber,
      column: issue.column,
      severity: issue.severity,
      issueType: issue.issueType,
      currentValue: issue.currentValue,
      message: issue.message,
      suggestedFix: issue.suggestedFix,
    }));
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colour } };
    });
    row.commit();
  }

  sheet.commit();
}

function addFullUploadedFileSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  originalColumns: string[],
  originalRows: { rowNumber: number; data: unknown }[],
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
    for (const col of originalColumns) {
      rowData[col] = data[col] ?? '';
    }
    sheet.addRow(excelSafeRecord(rowData)).commit();
  }

  sheet.commit();
}

const AUTO_FIX_GREEN = 'FFD1FAE5';

function addShopifyTemplateSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  columnMapping: Record<string, string>,
  originalRows: { rowNumber: number; data: unknown }[],
  autoFixes: AutoFixEntry[] = [],
  heliosMigratedTag = false,
  moveDuplicatesToNotes = false,
  issues: CustomerValidationIssue[] = [],
  mergeMatchingDuplicates = false,
) {
  const sheet = workbook.addWorksheet('Shopify Template');

  if (Object.keys(columnMapping).length === 0 || originalRows.length === 0) {
    sheet.addRow(['No column mapping was applied for this validation run.']);
    sheet.commit();
    return;
  }

  // Determine which Shopify columns are present, in canonical SHOPIFY_COLUMNS order.
  // Append targets ("Add to Tags"/"Add to Note") count as Tags/Note.
  const mappedTargets = new Set(Object.values(columnMapping).map(resolveMappingTarget));
  const shopifyColumns = SHOPIFY_COLUMNS.filter((col) => mappedTargets.has(col));

  // If appending HeliosMigrated tag and Tags isn't already mapped, add it as a trailing column
  const tagsAlreadyMapped = shopifyColumns.includes('Tags');
  const effectiveColumns: string[] =
    heliosMigratedTag && !tagsAlreadyMapped ? [...shopifyColumns, 'Tags'] : [...shopifyColumns];

  // The transformation itself (mapping + auto-fixes + optional merge +
  // move-to-Notes + Helios tag) is shared with the test-store import so what
  // gets imported is exactly what this sheet shows.
  const { rows: templateRows, emailDupes, phoneDupes, anyMerges, fixMap } = buildTemplateDataset({
    originalRows,
    columnMapping,
    autoFixes,
    heliosMigratedTag,
    moveDuplicatesToNotes,
    mergeMatchingDuplicates,
  });
  const emailGroups = emailDupes.groups;
  const phoneGroups = phoneDupes.groups;

  // Moving duplicates needs Note (moved value) and Tags (DuplicateEmailNotes /
  // DuplicatePhoneNotes marker) columns even when neither was mapped
  if (moveDuplicatesToNotes && (emailDupes.repeats.size > 0 || phoneDupes.repeats.size > 0)) {
    if (!effectiveColumns.includes('Note')) effectiveColumns.push('Note');
    if (!effectiveColumns.includes('Tags')) effectiveColumns.push('Tags');
  }

  // "Keep" columns pass through as trailing columns under their original names
  const keptColumns = Object.entries(columnMapping)
    .filter(([, tgt]) => tgt === KEEP_COLUMN)
    .map(([src]) => src)
    .filter((src) => !effectiveColumns.includes(src));
  effectiveColumns.push(...keptColumns);

  // One leading marker column per Error issue type present in the run (an "X"
  // per affected row) — filter a column to X in Excel to isolate the rows that
  // need that fix. DuplicateEmail/DuplicatePhone are skipped: the duplicate-
  // group columns already cover them.
  const errorTypesByRow = new Map<number, Set<string>>();
  const errorTypes: string[] = [];
  for (const issue of issues) {
    if (issue.severity !== 'Error') continue;
    if (issue.issueType === 'DuplicateEmail' || issue.issueType === 'DuplicatePhone') continue;
    if (!errorTypesByRow.has(issue.rowNumber)) errorTypesByRow.set(issue.rowNumber, new Set());
    errorTypesByRow.get(issue.rowNumber)!.add(issue.issueType);
    if (!errorTypes.includes(issue.issueType)) errorTypes.push(issue.issueType);
  }
  errorTypes.sort();
  // Internal column keys are prefixed so an issue type can never collide with
  // a Shopify column name
  const errorKey = (type: string) => `err:${type}`;

  // Marker columns lead (one per error type, duplicate groups, merged-rows
  // audit trail when merging happened), then Row Number, then the Shopify
  // columns
  const leadingColumnCount = errorTypes.length + 3 + (anyMerges ? 1 : 0);
  sheet.columns = [
    ...errorTypes.map((type) => ({ header: type, key: errorKey(type), width: 22 })),
    { header: 'Duplicate Group # (Email)', key: 'dupEmailGroup', width: 22 },
    { header: 'Duplicate Group # (Phone)', key: 'dupPhoneGroup', width: 22 },
    ...(anyMerges ? [{ header: 'Merged From Rows', key: 'mergedFromRows', width: 18 }] : []),
    { header: 'Row Number', key: 'rowNumber', width: 12 },
    ...effectiveColumns.map((col) => ({ header: col, key: col, width: 26 })),
  ];

  sheet.autoFilter = {
    from: 'A1',
    to: `${columnIndexToLetter(effectiveColumns.length + leadingColumnCount)}1`,
  };
  styleHeader(sheet.getRow(1), HEADER_COLOURS['Shopify Template']);

  // Highlight the error and duplicate-group header cells in red
  const headerRow = sheet.getRow(1);
  for (let c = 1; c <= errorTypes.length + 2; c++) {
    headerRow.getCell(c).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: HEADER_COLOURS['Errors'] },
    };
  }

  for (const row of templateRows) {
    const rowFixes = fixMap.get(row.rowNumber);
    const rowData: Record<string, string | number> = {
      rowNumber: row.rowNumber,
      dupEmailGroup: emailGroups.get(row.rowNumber) ?? '',
      dupPhoneGroup: phoneGroups.get(row.rowNumber) ?? '',
    };
    if (anyMerges) {
      rowData.mergedFromRows = row.mergedFrom.join(', ');
    }
    const rowErrorTypes = errorTypesByRow.get(row.rowNumber);
    for (const type of errorTypes) {
      rowData[errorKey(type)] = rowErrorTypes?.has(type) ? 'X' : '';
    }

    // Records are final (move-to-Notes / Helios tag already applied by
    // buildTemplateDataset) — just emit them.
    for (const shopifyCol of effectiveColumns) {
      rowData[shopifyCol] = row.record[shopifyCol] ?? '';
    }

    const excelRow = sheet.addRow(excelSafeRecord(rowData));

    if (rowFixes) {
      effectiveColumns.forEach((shopifyCol, colIdx) => {
        if (rowFixes.has(shopifyCol)) {
          const cell = excelRow.getCell(colIdx + leadingColumnCount + 1);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AUTO_FIX_GREEN } };
        }
      });
    }

    excelRow.commit();
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
