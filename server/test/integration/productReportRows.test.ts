import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough, Writable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import ExcelJS from 'exceljs';
import prisma from '../../src/db/prisma';
import {
  streamProductImportReport,
  streamProductPrecheckReport,
} from '../../src/reports/productImportReport';
import { createProductUpload, getUploadRun } from '../../src/services/productUpload.service';
import { resetDb } from './resetDb';

// The product reports label each CSV row with its product's verdict. They used
// to key that on the row's OWN Handle cell, while groupByHandle (and so the
// pre-check and the import) attaches a blank-Handle row to the product above
// it — so a continuation row of a rejected product read "Imports". And the
// uploaded-file columns were keyed by header text, so a CSV column named like a
// tool column ("Row Number", "Result", ...) overwrote the tool's column.
// Synthetic data only.

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// A blank-Handle row before any product, a product with a blank-Handle
// continuation row, and a second product. Two CSV columns share their header
// text with tool columns of the sheets.
const COLUMNS = ['Handle', 'Title', 'Row Number', 'Result', 'Expected Result', 'Shopify Code'];
const ROWS: { rowNumber: number; data: Record<string, string> }[] = [
  { rowNumber: 2, data: { Handle: '', Title: 'stray', 'Row Number': 'csv-2', Result: 'csv-r2', 'Expected Result': 'csv-e2', 'Shopify Code': 'csv-c2' } },
  { rowNumber: 3, data: { Handle: 'alpha', Title: 'Alpha', 'Row Number': 'csv-3', Result: 'csv-r3', 'Expected Result': 'csv-e3', 'Shopify Code': 'csv-c3' } },
  { rowNumber: 4, data: { Handle: '', Title: '', 'Row Number': 'csv-4', Result: 'csv-r4', 'Expected Result': 'csv-e4', 'Shopify Code': 'csv-c4' } },
  { rowNumber: 5, data: { Handle: 'beta', Title: 'Beta', 'Row Number': 'csv-5', Result: 'csv-r5', 'Expected Result': 'csv-e5', 'Shopify Code': 'csv-c5' } },
];

async function seedUpload(): Promise<string> {
  const id = uuidv4();
  await prisma.productUploadRun.create({
    data: {
      id,
      fileName: 'products.csv',
      productCount: 2,
      originalColumns: COLUMNS,
      precheckErrors: 1,
      originalRows: { create: ROWS.map((r) => ({ id: uuidv4(), ...r })) },
      validationIssues: {
        create: [{
          id: uuidv4(),
          rowNumber: 3,
          handle: 'alpha',
          columnName: 'Status',
          severity: 'Error',
          issueType: 'InvalidStatus',
          currentValue: 'live',
          message: 'Status "live" is not active, draft, archived or unlisted.',
          suggestedFix: 'Use active, draft or archived.',
        }],
      },
    },
  });
  return id;
}

async function readSheet(
  write: (out: Writable) => Promise<void>,
): Promise<{ header: string[]; rows: string[][] }> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  await write(out);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  const sheet = wb.getWorksheet('Full Uploaded File')!;
  const all: string[][] = [];
  sheet.eachRow((row) => {
    const values: string[] = [];
    for (let c = 1; c <= sheet.columnCount; c++) values.push(String(row.getCell(c).value ?? ''));
    all.push(values);
  });
  return { header: all[0], rows: all.slice(1) };
}

runIf('product reports: per-row verdicts and column keys', () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it('pre-check report: continuation rows carry their product verdict; a stray row is not a product', async () => {
    const uploadId = await seedUpload();
    const { header, rows } = await readSheet((out) => streamProductPrecheckReport(uploadId, out, () => {}));

    expect(header).toEqual(['Row Number', 'Expected Result', 'Pre-check Errors', ...COLUMNS]);
    expect(rows.map((r) => r[1])).toEqual(['Not a product (no Handle)', 'Rejected', 'Rejected', 'Imports']);
    // Tool columns hold the tool's values; the same-named CSV columns keep the file's.
    expect(rows.map((r) => r[0])).toEqual(['2', '3', '4', '5']);
    expect(rows[1].slice(3)).toEqual(['alpha', 'Alpha', 'csv-3', 'csv-r3', 'csv-e3', 'csv-c3']);
  });

  it('import report: continuation rows carry their product result; a stray row is not a product', async () => {
    const uploadId = await seedUpload();
    const importRunId = uuidv4();
    await prisma.productImportRun.create({
      data: {
        id: importRunId,
        uploadId,
        shopDomain: 'qa-test.myshopify.com',
        status: 'COMPLETED',
        successCount: 1,
        errorCount: 1,
        rowResults: {
          create: [
            { id: uuidv4(), handle: 'alpha', accepted: false, shopifyCode: 'INVALID', shopifyField: 'status', message: 'Status is invalid' },
            { id: uuidv4(), handle: 'beta', accepted: true, shopifyProductId: 'gid://shopify/Product/1' },
          ],
        },
      },
    });
    const { header, rows } = await readSheet((out) => streamProductImportReport(importRunId, out, () => {}));

    expect(header).toEqual(['Row Number', 'Result', 'Shopify Code', 'Shopify Message', ...COLUMNS]);
    expect(rows.map((r) => r[1])).toEqual(['Not a product (no Handle)', 'Rejected', 'Rejected', 'Accepted']);
    expect(rows.map((r) => r[2])).toEqual(['', 'INVALID', 'INVALID', '']);
    expect(rows.map((r) => r[0])).toEqual(['2', '3', '4', '5']);
    expect(rows[2].slice(4)).toEqual(['', '', 'csv-4', 'csv-r4', 'csv-e4', 'csv-c4']);
  });
});

runIf('product upload: issue order', () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  // The upload response sorted by row only (rule order within a row) while the
  // upload detail sorted by (row, issue type): the same issues, listed two ways.
  it('lists the issues in the same order in the upload response and the upload detail', async () => {
    const long = 'L'.repeat(300);
    const csv = [
      'Handle,Title,Variant SKU,Variant Barcode,Variant Price,Cost per item,Status',
      `alpha,,${long},${long},abc,cheap,live`,
      `beta,Beta,B1,,-5,,`,
    ].join('\n');
    const file = path.join(os.tmpdir(), `qa-product-order-${uuidv4()}.csv`);
    fs.writeFileSync(file, csv);
    try {
      const posted = await createProductUpload(file, 'order.csv');
      const fetched = await getUploadRun(posted.uploadId);
      const key = (i: { rowNumber: number; issueType: string; column: string }) =>
        `${i.rowNumber}:${i.issueType}:${i.column}`;
      expect(posted.issues.length).toBeGreaterThan(4);
      expect(fetched!.issues.map(key)).toEqual(posted.issues.map(key));
      expect(posted.issues.map(key).slice(0, 3)).toEqual([
        '2:FieldTooLong:Variant Barcode',
        '2:FieldTooLong:Variant SKU',
        '2:InvalidStatus:Status',
      ]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
