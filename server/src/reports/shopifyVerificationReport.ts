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
import { excelSafeRecord, excelSafeText } from './excelCell';
import { buildTemplateDataset, TemplateDataset } from './templateDataset';

// Written with ExcelJS's *streaming* workbook writer: every row is committed
// (flushed to the output stream and freed) as it's built. This report has four
// sheets, three of which repeat every uploaded row (Rows With Shopify Result,
// Full Uploaded File, Shopify Template), so on a large import the in-memory
// workbook plus the writeBuffer copy would exhaust the V8 heap. Streaming keeps
// memory roughly flat regardless of row count.

const HEADER_COLOURS: Record<string, string> = {
  Summary: 'FF1E3A5F',
  Errors: 'FFB91C1C',
  'Rows With Shopify Result': 'FF065F46',
  'Full Uploaded File': 'FF065F46',
  'Shopify Template': 'FF004C3F',
};

const RESULT_COLOURS = {
  accepted: 'FFD1FAE5',
  rejected: 'FFFEE2E2',
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
        include: { originalRows: { orderBy: { rowNumber: 'asc' } } },
      },
    },
  });

  if (!importRun) throw new Error(`Import run "${importRunId}" not found.`);

  const validationRun = importRun.validationRun as typeof importRun.validationRun & {
    originalColumns: unknown;
    columnMapping: unknown;
    originalRows: OriginalRow[];
  };

  // The raw rows this report is built FROM were purged for retention. Say so, as
  // the prevalidation report does — a 410 with a sentence beats a workbook whose
  // every CSV cell is blank.
  if (validationRun.piiPurgedAt) {
    throw new HttpError(410, purgedMessage(validationRun.piiPurgedAt));
  }

  const originalColumns = Array.isArray(validationRun.originalColumns)
    ? (validationRun.originalColumns as string[])
    : [];
  const columnMapping =
    validationRun.columnMapping &&
    typeof validationRun.columnMapping === 'object' &&
    !Array.isArray(validationRun.columnMapping)
      ? (validationRun.columnMapping as Record<string, string>)
      : {};

  const rowResults = importRun.rowResults as ReportRowResult[];
  // Rebuilt once from the run's own flags with the very function the import used,
  // so the template sheet shows what was SENT and the reasons agree with it.
  const sent = sentDataset(validationRun);
  const notImported = reasonsFromDataset(sent);
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

  addRejectedSheet(
    workbook,
    rowResults.filter((r) => !r.accepted),
    originalColumns,
    originalByRow,
  );
  addRowsWithShopifyResultSheet(
    workbook,
    originalColumns,
    validationRun.originalRows,
    rowResults,
    notImported,
  );
  addFullUploadedFileSheet(workbook, originalColumns, validationRun.originalRows);
  addShopifyTemplateSheet(workbook, columnMapping, validationRun.originalRows, sent, rowResults, notImported);

  await workbook.commit();
}

type SentRun = {
  originalRows: OriginalRow[];
  columnMapping: unknown;
  moveDuplicatesToNotes?: boolean | null;
  mergeMatchingDuplicates?: boolean | null;
  moveInvalidContactToNotes?: boolean | null;
  fillMissingContactName?: boolean | null;
};

// The dataset the import sent, built with exactly the arguments the import's
// buildImportRows passes: the run's cleanup flags, no HeliosMigrated tag and no
// auto-fixes (the import applies neither).
function sentDataset(run: SentRun): TemplateDataset {
  return buildTemplateDataset({
    originalRows: run.originalRows,
    columnMapping: run.columnMapping as Record<string, string> | null,
    moveDuplicatesToNotes: run.moveDuplicatesToNotes ?? false,
    mergeMatchingDuplicates: run.mergeMatchingDuplicates ?? false,
    moveInvalidContactToNotes: run.moveInvalidContactToNotes ?? false,
    fillMissingContactName: run.fillMissingContactName ?? false,
  });
}

function reasonsFromDataset(dataset: TemplateDataset): Map<number, string> {
  const reasons = new Map<number, string>();
  for (const row of dataset.droppedBlank) reasons.set(row, 'Not imported: blank line');
  for (const kept of dataset.rows) {
    for (const absorbed of kept.mergedFrom) reasons.set(absorbed, `Not imported: merged into row ${kept.rowNumber}`);
  }
  return reasons;
}

// Worksheet column keys. ExcelJS keeps ONE column per key, so keying by header
// text let a CSV column named "Row Number" or "Shopify Result" (natural in a CSV
// saved from one of these reports and uploaded again) overwrite the tool's own
// column. The tool's columns use fixed identifiers; CSV and template columns are
// keyed by position under a prefix no tool key uses, so nothing can collide.
const csvKey = (index: number) => `csv:${index}`;
const templateKey = (index: number) => `tpl:${index}`;

// Why a CSV row has no Shopify result. The import sends the template dataset,
// not the raw file, so a row can be left out on purpose: a blank line dropped by
// "Name contactless rows", or a duplicate absorbed by "Merge matching
// duplicates". Rebuilt from the run's own flags (the same pure function the
// import used), so the report can say which, instead of a bare "Not imported".
export function notImportedReasons(run: {
  originalRows: OriginalRow[];
  columnMapping: unknown;
  moveDuplicatesToNotes?: boolean | null;
  mergeMatchingDuplicates?: boolean | null;
  moveInvalidContactToNotes?: boolean | null;
  fillMissingContactName?: boolean | null;
}): Map<number, string> {
  if (!run.mergeMatchingDuplicates && !run.fillMissingContactName) return new Map();
  return reasonsFromDataset(sentDataset(run));
}

function styleHeader(row: ExcelJS.Row, bgArgb: string) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });
  row.height = 20;
}

// Every row Shopify rejected, with Shopify's own field/code/message next to the
// original CSV row, so the fix is visible without cross-referencing anything.
function addRejectedSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  results: ReportRowResult[],
  originalColumns: string[],
  originalByRow: Map<number, Record<string, string>>,
) {
  const sheet = workbook.addWorksheet('Errors');
  const columns = [
    { header: 'Row Number', key: 'rowNumber', width: 22 },
    { header: 'Shopify Result', key: 'shopifyResult', width: 22 },
    { header: 'Shopify Field', key: 'shopifyField', width: 22 },
    { header: 'Shopify Code', key: 'shopifyCode', width: 22 },
    { header: 'Shopify Message', key: 'shopifyMessage', width: 42 },
    ...originalColumns.map((col, i) => ({ header: excelSafeText(col), key: csvKey(i), width: 22 })),
  ];

  sheet.columns = columns;
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(columns.length)}1` };
  styleHeader(sheet.getRow(1), HEADER_COLOURS.Errors);

  for (const result of results) {
    const original = originalByRow.get(result.rowNumber) ?? {};
    const rowData: Record<string, string | number | boolean> = {
      rowNumber: result.rowNumber,
      shopifyResult: result.accepted ? 'Accepted' : 'Rejected',
      shopifyField: result.shopifyField ?? '',
      shopifyCode: result.shopifyCode ?? '',
      shopifyMessage: result.message ?? '',
    };
    originalColumns.forEach((col, i) => { rowData[csvKey(i)] = original[col] ?? ''; });
    const row = sheet.addRow(excelSafeRecord(rowData));
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RESULT_COLOURS.rejected } };
    });
    row.commit();
  }

  sheet.commit();
}

function addRowsWithShopifyResultSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  originalColumns: string[],
  originalRows: OriginalRow[],
  rowResults: ReportRowResult[],
  notImported: Map<number, string>,
) {
  const sheet = workbook.addWorksheet('Rows With Shopify Result');
  const resultByRow = new Map(rowResults.map((r) => [r.rowNumber, r]));
  const columns = [
    { header: 'Row Number', key: 'rowNumber', width: 22 },
    { header: 'Shopify Result', key: 'shopifyResult', width: 22 },
    { header: 'Shopify Customer ID', key: 'shopifyCustomerId', width: 22 },
    { header: 'Shopify Field', key: 'shopifyField', width: 22 },
    { header: 'Shopify Code', key: 'shopifyCode', width: 22 },
    { header: 'Shopify Message', key: 'shopifyMessage', width: 42 },
    ...originalColumns.map((col, i) => ({ header: excelSafeText(col), key: csvKey(i), width: 22 })),
  ];

  sheet.columns = columns;
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(columns.length)}1` };
  styleHeader(sheet.getRow(1), HEADER_COLOURS['Rows With Shopify Result']);

  for (const origRow of originalRows) {
    const data = origRow.data as Record<string, string>;
    const result = resultByRow.get(origRow.rowNumber);
    const rowData: Record<string, string | number | boolean> = {
      rowNumber: origRow.rowNumber,
      shopifyResult: result ? (result.accepted ? 'Accepted' : 'Rejected') : notImported.get(origRow.rowNumber) ?? 'Not imported',
      shopifyCustomerId: result?.shopifyCustomerId ?? '',
      shopifyField: result?.shopifyField ?? '',
      shopifyCode: result?.shopifyCode ?? '',
      shopifyMessage: result?.message ?? '',
    };
    originalColumns.forEach((col, i) => { rowData[csvKey(i)] = data[col] ?? ''; });
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

  sheet.columns = [
    { header: 'Row Number', key: 'rowNumber', width: 12 },
    ...originalColumns.map((col, i) => ({ header: excelSafeText(col), key: csvKey(i), width: 22 })),
  ];
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(originalColumns.length + 1)}1` };
  styleHeader(sheet.getRow(1), HEADER_COLOURS['Full Uploaded File']);

  for (const origRow of originalRows) {
    const data = origRow.data as Record<string, string>;
    const rowData: Record<string, string | number> = { rowNumber: origRow.rowNumber };
    originalColumns.forEach((col, i) => { rowData[csvKey(i)] = data[col] ?? ''; });
    sheet.addRow(excelSafeRecord(rowData)).commit();
  }

  sheet.commit();
}

function addShopifyTemplateSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  columnMapping: Record<string, string>,
  originalRows: OriginalRow[],
  sent: TemplateDataset,
  rowResults: ReportRowResult[],
  notImported: Map<number, string>,
) {
  const sheet = workbook.addWorksheet('Shopify Template');

  if (Object.keys(columnMapping).length === 0 || originalRows.length === 0) {
    sheet.addRow(['No column mapping was applied for this validation run.']);
    sheet.commit();
    return;
  }

  // Append targets ("Add to Tags"/"Add to Note") count as Tags/Note.
  const mappedTargets = new Set(Object.values(columnMapping).map(resolveMappingTarget));
  const shopifyColumns: string[] = SHOPIFY_COLUMNS.filter((col) => mappedTargets.has(col));

  // Whatever a cleanup option wrote has to appear as a column, or the sheet would
  // hide a value the import sent — same rule as the prevalidation report's sheet.
  const ensure = (...cols: string[]) => {
    for (const col of cols) if (!shopifyColumns.includes(col)) shopifyColumns.push(col);
  };
  if (sent.invalidMoved.size > 0 || sent.duplicatesMoved.size > 0) ensure('Note', 'Tags');
  if (sent.namesFilled.size > 0) ensure('First Name', 'Tags');

  // "Keep" columns pass through as trailing columns under their original names
  const keptColumns = Object.entries(columnMapping)
    .filter(([, tgt]) => tgt === KEEP_COLUMN)
    .map(([src]) => src)
    .filter((src) => !shopifyColumns.includes(src));
  shopifyColumns.push(...keptColumns);

  const resultByRow = new Map(rowResults.map((r) => [r.rowNumber, r]));
  const columns = [
    { header: 'Row Number', key: 'rowNumber', width: 24 },
    { header: 'Shopify Result', key: 'shopifyResult', width: 24 },
    { header: 'Shopify Field', key: 'shopifyField', width: 24 },
    { header: 'Shopify Code', key: 'shopifyCode', width: 24 },
    { header: 'Shopify Message', key: 'shopifyMessage', width: 42 },
    ...shopifyColumns.map((col, i) => ({ header: excelSafeText(col), key: templateKey(i), width: 24 })),
  ];
  sheet.columns = columns;
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(columns.length)}1` };
  styleHeader(sheet.getRow(1), HEADER_COLOURS['Shopify Template']);

  // The records the import SENT (mapping plus the run's cleanup options), keyed by
  // CSV row number — the same numbers Shopify's results are recorded against. A row
  // the import left out (blank line, merged into another) has no record; it keeps
  // its line with the reason and empty fields, so the sheet still lines up with
  // the CSV and with the other sheets.
  const sentByRow = new Map(sent.rows.map((r) => [r.rowNumber, r.record]));

  for (const origRow of originalRows) {
    const result = resultByRow.get(origRow.rowNumber);
    const rowData: Record<string, string | number> = {
      rowNumber: origRow.rowNumber,
      shopifyResult: result ? (result.accepted ? 'Accepted' : 'Rejected') : notImported.get(origRow.rowNumber) ?? 'Not imported',
      shopifyField: result?.shopifyField ?? '',
      shopifyCode: result?.shopifyCode ?? '',
      shopifyMessage: result?.message ?? '',
    };
    const record = sentByRow.get(origRow.rowNumber) ?? {};
    shopifyColumns.forEach((col, i) => { rowData[templateKey(i)] = record[col] ?? ''; });
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
