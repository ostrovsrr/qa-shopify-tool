import { Writable } from 'stream';
import ExcelJS from 'exceljs';
import prisma from '../db/prisma';
import { HttpError } from '../errors';
import { purgedMessage } from '../services/retention.service';
import { excelSafeRecord, excelSafeText } from './excelCell';

// Product import report (no validator columns; results keyed by Handle):
//   • Products With Shopify Result — one row per product, in CSV order
//   • Full Uploaded File — the raw CSV rows, each carrying its product's
//     verdict (Result / Shopify Code / Shopify Message)
//
// Written with ExcelJS's *streaming* workbook writer, and — crucially — the
// upload's rows are read from the DB in bounded pages rather than all at once.
// A large import (100k+ products spanning ~1M CSV rows) would otherwise hold the
// entire upload plus a normalized copy in memory before a single cell is
// written, which alone exhausts the V8 heap regardless of output streaming.

const BATCH = 5000;

const HEADER_COLOURS = {
  Summary: 'FF1E3A5F',
  Products: 'FF065F46',
  Uploaded: 'FF004C3F',
};

const RESULT_COLOURS = {
  accepted: 'FFD1FAE5',
  rejected: 'FFFEE2E2',
};

interface ReportResult {
  handle: string;
  accepted: boolean;
  shopifyProductId: string | null;
  shopifyCode: string | null;
  shopifyField: string | null;
  message: string | null;
  storeId: string | null;
}

// Keyset-paginate an upload's original rows in rowNumber order. rowNumber is
// assigned per CSV line (monotonic, unique within an upload), so `gt: cursor`
// walks the whole file a bounded page at a time without large OFFSETs.
async function* iterOriginalRows(
  uploadRunId: string,
): AsyncGenerator<{ rowNumber: number; data: unknown }[]> {
  let cursor = 0;
  for (;;) {
    const rows = await prisma.productOriginalRow.findMany({
      where: { uploadRunId, rowNumber: { gt: cursor } },
      orderBy: { rowNumber: 'asc' },
      take: BATCH,
      select: { rowNumber: true, data: true },
    });
    if (rows.length === 0) return;
    yield rows;
    cursor = rows[rows.length - 1].rowNumber;
    if (rows.length < BATCH) return;
  }
}

// Streams the workbook to `stream`. `onReady(sourceFileName)` fires once, after
// the initial DB read and before any bytes are written, so the caller can set
// the Content-Disposition filename before the stream starts.
export async function streamProductImportReport(
  importRunId: string,
  stream: Writable,
  onReady: (sourceFileName: string) => void,
): Promise<void> {
  // Deliberately NOT including uploadRun.originalRows — those are paged below.
  const run = await prisma.productImportRun.findUnique({
    where: { id: importRunId },
    include: { rowResults: true, batchJobs: true, uploadRun: true },
  });
  if (!run) throw new Error(`Import run "${importRunId}" not found.`);

  // See excelReport — the source rows were purged for retention (D13).
  if (run.uploadRun.piiPurgedAt) throw new HttpError(410, purgedMessage(run.uploadRun.piiPurgedAt));

  const originalColumns = Array.isArray(run.uploadRun.originalColumns)
    ? (run.uploadRun.originalColumns as string[])
    : [];

  const results = run.rowResults as ReportResult[];
  const resultByHandle = new Map(results.map((r) => [r.handle, r]));

  // storeId → shopDomain (for the per-store/store columns).
  const shopByStore = new Map<string, string>();
  for (const job of run.batchJobs) {
    if (job.storeId) shopByStore.set(job.storeId, job.shopDomain);
  }
  const shopLabel = (storeId: string | null): string =>
    storeId ? shopByStore.get(storeId) ?? storeId : run.shopDomain;

  // Pass 1: derive the product list (distinct Handles in first-seen order) and
  // each product's Title from its first row. normalizeRecord only trims values,
  // so reading the raw cell and trimming is equivalent — no per-row copy needed.
  const seen = new Set<string>();
  const orderedHandles: string[] = [];
  const titleByHandle = new Map<string, string>();
  for await (const batch of iterOriginalRows(run.uploadId)) {
    for (const r of batch) {
      const data = (r.data ?? {}) as Record<string, string>;
      const handle = (data['Handle'] ?? '').trim();
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      orderedHandles.push(handle);
      titleByHandle.set(handle, (data['Title'] ?? '').trim());
    }
  }

  // Headers must be set before the workbook writes its first byte.
  onReady(run.uploadRun.fileName);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    // Inline strings — a shared-strings table would accumulate every distinct
    // string in memory, defeating the point of streaming.
    useSharedStrings: false,
  });
  workbook.creator = 'Shopify Products QA Tool';
  workbook.created = new Date();

  addProductsSheet(workbook, orderedHandles, resultByHandle, titleByHandle, shopLabel);
  await addFullUploadedFileSheet(workbook, originalColumns, run.uploadId, resultByHandle);

  await workbook.commit();
}

function styleHeader(row: ExcelJS.Row, bgArgb: string): void {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });
  row.height = 20;
}

function addProductsSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  handles: string[],
  resultByHandle: Map<string, ReportResult>,
  titleByHandle: Map<string, string>,
  shopLabel: (storeId: string | null) => string,
): void {
  const sheet = workbook.addWorksheet('Products With Shopify Result');
  const columns = [
    'Handle',
    'Title',
    'Result',
    'Shopify Product ID',
    'Shopify Field',
    'Shopify Code',
    'Shopify Message',
    'Store',
  ];
  sheet.columns = columns.map((col) => ({
    header: col,
    key: col,
    width: col === 'Shopify Message' ? 50 : col === 'Shopify Product ID' ? 30 : 22,
  }));
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(columns.length)}1` };
  styleHeader(sheet.getRow(1), HEADER_COLOURS.Products);

  for (const handle of handles) {
    const result = resultByHandle.get(handle);
    const row = sheet.addRow(excelSafeRecord({
      Handle: handle,
      Title: titleByHandle.get(handle) ?? '',
      Result: result ? (result.accepted ? 'Accepted' : 'Rejected') : 'Not imported',
      'Shopify Product ID': result?.shopifyProductId ?? '',
      'Shopify Field': result?.shopifyField ?? '',
      'Shopify Code': result?.shopifyCode ?? '',
      'Shopify Message': result?.message ?? '',
      Store: result ? shopLabel(result.storeId) : '',
    }));
    if (result) {
      row.getCell(3).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: result.accepted ? RESULT_COLOURS.accepted : RESULT_COLOURS.rejected },
      };
    }
    row.commit();
  }

  sheet.commit();
}

async function addFullUploadedFileSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  originalColumns: string[],
  uploadRunId: string,
  resultByHandle: Map<string, ReportResult>,
): Promise<void> {
  const sheet = workbook.addWorksheet('Full Uploaded File');

  if (originalColumns.length === 0) {
    sheet.addRow(['No uploaded file data available.']);
    sheet.commit();
    return;
  }

  const allColumns = ['Row Number', 'Result', 'Shopify Code', 'Shopify Message', ...originalColumns];
  sheet.columns = allColumns.map((col) => ({
    header: excelSafeText(col),
    key: col,
    width: col === 'Row Number' ? 12 : col === 'Result' ? 14 : col === 'Shopify Message' ? 50 : 22,
  }));
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(allColumns.length)}1` };
  styleHeader(sheet.getRow(1), HEADER_COLOURS.Uploaded);

  // Page the rows so only BATCH of them are ever resident at once.
  let wrote = false;
  for await (const batch of iterOriginalRows(uploadRunId)) {
    for (const origRow of batch) {
      const data = (origRow.data ?? {}) as Record<string, string>;
      // Results are per product (Handle); every CSV row of a product — variant
      // and image rows included — carries its product's verdict.
      const result = resultByHandle.get((data['Handle'] ?? '').trim());
      const rowData: Record<string, string | number> = {
        'Row Number': origRow.rowNumber,
        Result: result ? (result.accepted ? 'Accepted' : 'Rejected') : 'Not imported',
        'Shopify Code': result?.shopifyCode ?? '',
        'Shopify Message': result?.message ?? '',
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
      wrote = true;
    }
  }
  if (!wrote) sheet.addRow(['No uploaded file data available.']).commit();

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
