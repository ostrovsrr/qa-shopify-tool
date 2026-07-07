import ExcelJS from 'exceljs';
import prisma from '../db/prisma';
import { groupByHandle } from '../services/productCsvParser';
import { normalizeRecord } from '../utils/normalize';
import { ProductCsvRow } from '../types';

// Product import report (no validator columns; results keyed by Handle):
//   • Summary — run metadata + accepted/rejected (+ per-store for a batch)
//   • Products With Shopify Result — one row per product, in CSV order
//   • Rejections — grouped by (field, code) with counts + samples
//   • Full Uploaded File — the raw CSV rows, for reference

const HEADER_COLOURS = {
  Summary: 'FF1E3A5F',
  Products: 'FF065F46',
  Rejections: 'FFB91C1C',
  Uploaded: 'FF004C3F',
};

const RESULT_COLOURS = {
  accepted: 'FFD1FAE5',
  rejected: 'FFFEE2E2',
};

interface OriginalRow {
  rowNumber: number;
  data: unknown;
}

interface ReportResult {
  handle: string;
  accepted: boolean;
  shopifyProductId: string | null;
  shopifyCode: string | null;
  shopifyField: string | null;
  message: string | null;
  storeId: string | null;
}

export async function generateProductImportReport(importRunId: string): Promise<Buffer> {
  const run = await prisma.productImportRun.findUnique({
    where: { id: importRunId },
    include: {
      rowResults: true,
      batchJobs: true,
      uploadRun: { include: { originalRows: { orderBy: { rowNumber: 'asc' } } } },
    },
  });
  if (!run) throw new Error(`Import run "${importRunId}" not found.`);

  const originalColumns = Array.isArray(run.uploadRun.originalColumns)
    ? (run.uploadRun.originalColumns as string[])
    : [];
  const originalRows = run.uploadRun.originalRows as OriginalRow[];

  // Rebuild Handle groups (CSV product order) so the products sheet lists every
  // product even if a result is missing, and we can show each product's Title.
  const csvRows: ProductCsvRow[] = originalRows.map((r) => {
    const data = (r.data ?? {}) as Record<string, string>;
    return { rowNumber: r.rowNumber, original: data, normalized: normalizeRecord(data) };
  });
  const groups = groupByHandle(csvRows);
  const titleByHandle = new Map(
    groups.map((g) => [g.handle, (g.rows[0]?.normalized['Title'] ?? '').trim()]),
  );

  const results = run.rowResults as ReportResult[];
  const resultByHandle = new Map(results.map((r) => [r.handle, r]));

  // storeId → shopDomain (for the per-store/store columns).
  const shopByStore = new Map<string, string>();
  for (const job of run.batchJobs) {
    if (job.storeId) shopByStore.set(job.storeId, job.shopDomain);
  }
  const shopLabel = (storeId: string | null): string =>
    storeId ? shopByStore.get(storeId) ?? storeId : run.shopDomain;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Shopify Products QA Tool';
  workbook.created = new Date();

  addSummarySheet(workbook, run, results, shopLabel);
  addProductsSheet(workbook, groups, resultByHandle, titleByHandle, shopLabel);
  addRejectionsSheet(workbook, results);
  addFullUploadedFileSheet(workbook, originalColumns, originalRows);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function styleHeader(row: ExcelJS.Row, bgArgb: string): void {
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
    uploadId: string;
    shopDomain: string;
    bulkOperationId: string | null;
    status: string;
    error: string | null;
    createdAt: Date;
    uploadRun: { fileName: string; productCount: number };
  },
  results: ReportResult[],
  shopLabel: (storeId: string | null) => string,
): void {
  const sheet = workbook.addWorksheet('Summary');
  sheet.columns = [{ width: 34 }, { width: 64 }];

  const title = sheet.addRow(['Shopify Products QA Tool — Import Report']);
  title.getCell(1).font = { bold: true, size: 14, color: { argb: HEADER_COLOURS.Summary } };
  sheet.addRow([]);

  const accepted = results.filter((r) => r.accepted).length;
  const rejected = results.length - accepted;

  const kv = (label: string, value: string | number): void => {
    const r = sheet.addRow([label, value]);
    r.getCell(1).font = { bold: true };
  };

  kv('File Name', run.uploadRun.fileName);
  kv('Upload ID', run.uploadId);
  kv('Import Run ID', run.id);
  kv('Shop Domain', run.shopDomain);
  kv('Bulk Operation ID', run.bulkOperationId ?? '(parallel batch — multiple)');
  kv('Bulk Operation Status', run.status);
  if (run.error) kv('Error', run.error);
  kv('Imported At', run.createdAt.toISOString());
  sheet.addRow([]);
  kv('Products In Upload', run.uploadRun.productCount);
  kv('Products With A Result', results.length);
  kv('Accepted', accepted);
  kv('Rejected', rejected);

  // Per-store breakdown (one row per store the results landed in).
  const perStore = new Map<string, { total: number; accepted: number; rejected: number }>();
  for (const r of results) {
    const key = r.storeId ?? '';
    const entry = perStore.get(key) ?? { total: 0, accepted: 0, rejected: 0 };
    entry.total++;
    if (r.accepted) entry.accepted++;
    else entry.rejected++;
    perStore.set(key, entry);
  }

  if (perStore.size > 1) {
    sheet.addRow([]);
    const header = sheet.addRow(['Store', 'Products / Accepted / Rejected']);
    styleHeader(header, HEADER_COLOURS.Summary);
    for (const [storeId, c] of perStore) {
      sheet.addRow([shopLabel(storeId || null), `${c.total} / ${c.accepted} / ${c.rejected}`]);
    }
  }
}

function addProductsSheet(
  workbook: ExcelJS.Workbook,
  groups: { handle: string }[],
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
  styleHeader(sheet.getRow(1), HEADER_COLOURS.Products);

  for (const group of groups) {
    const result = resultByHandle.get(group.handle);
    const row = sheet.addRow({
      Handle: group.handle,
      Title: titleByHandle.get(group.handle) ?? '',
      Result: result ? (result.accepted ? 'Accepted' : 'Rejected') : 'Not imported',
      'Shopify Product ID': result?.shopifyProductId ?? '',
      'Shopify Field': result?.shopifyField ?? '',
      'Shopify Code': result?.shopifyCode ?? '',
      'Shopify Message': result?.message ?? '',
      Store: result ? shopLabel(result.storeId) : '',
    });
    if (result) {
      row.getCell(3).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: result.accepted ? RESULT_COLOURS.accepted : RESULT_COLOURS.rejected },
      };
    }
  }

  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(columns.length)}1` };
}

function addRejectionsSheet(workbook: ExcelJS.Workbook, results: ReportResult[]): void {
  const sheet = workbook.addWorksheet('Rejections');
  sheet.columns = [
    { header: 'Shopify Field', key: 'field', width: 26 },
    { header: 'Shopify Code', key: 'code', width: 24 },
    { header: 'Count', key: 'count', width: 10 },
    { header: 'Sample Handles', key: 'handles', width: 50 },
    { header: 'Sample Message', key: 'message', width: 64 },
  ];
  styleHeader(sheet.getRow(1), HEADER_COLOURS.Rejections);

  const groups = new Map<
    string,
    { field: string; code: string; count: number; handles: string[]; messages: string[] }
  >();
  for (const r of results.filter((x) => !x.accepted)) {
    const key = `${r.shopifyField ?? ''}|${r.shopifyCode ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { field: r.shopifyField ?? '', code: r.shopifyCode ?? '', count: 0, handles: [], messages: [] };
      groups.set(key, g);
    }
    g.count++;
    if (g.handles.length < 10 && !g.handles.includes(r.handle)) g.handles.push(r.handle);
    if (r.message && g.messages.length < 1) g.messages.push(r.message);
  }

  if (groups.size === 0) {
    sheet.addRow(['No rejections — every product was accepted.']);
    return;
  }

  for (const g of [...groups.values()].sort((a, b) => b.count - a.count)) {
    sheet.addRow({
      field: g.field,
      code: g.code,
      count: g.count,
      handles: g.handles.join(', '),
      message: g.messages[0] ?? '',
    });
  }

  sheet.autoFilter = { from: 'A1', to: 'E1' };
}

function addFullUploadedFileSheet(
  workbook: ExcelJS.Workbook,
  originalColumns: string[],
  originalRows: OriginalRow[],
): void {
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
  styleHeader(sheet.getRow(1), HEADER_COLOURS.Uploaded);

  for (const origRow of originalRows) {
    const data = origRow.data as Record<string, string>;
    const rowData: Record<string, string | number> = { 'Row Number': origRow.rowNumber };
    for (const col of originalColumns) rowData[col] = data[col] ?? '';
    sheet.addRow(rowData);
  }

  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(allColumns.length)}1` };
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
