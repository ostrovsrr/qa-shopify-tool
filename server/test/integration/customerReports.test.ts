import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'stream';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import ExcelJS from 'exceljs';
import app from '../../src/index';
import prisma from '../../src/db/prisma';
import { HttpError } from '../../src/errors';
import { streamExcelReport } from '../../src/reports/excelReport';
import { streamShopifyVerificationReport } from '../../src/reports/shopifyVerificationReport';
import { jsonbKeyOrder } from '../../src/reports/templateDataset';
import { resetDb } from './resetDb';

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Synthetic data only. "Row Number" and "Shopify Result" are CSV headers here on
// purpose: a CSV saved from one of these reports and uploaded again carries them.
const COLUMNS = ['Row Number', 'Shopify Result', 'First Name', 'Email'];
const MAPPING = { 'First Name': 'First Name', Email: 'Email', 'Shopify Result': 'Add to Note' };

async function seedRun(opts: { piiPurgedAt?: Date; moveInvalidContactToNotes?: boolean } = {}) {
  const validationId = uuidv4();
  await prisma.validationRun.create({
    data: {
      id: validationId,
      fileName: 'customers.csv',
      fileType: 'CUSTOMER',
      totalRows: 3,
      errors: 0,
      originalColumns: COLUMNS,
      columnMapping: MAPPING,
      moveInvalidContactToNotes: opts.moveInvalidContactToNotes ?? false,
      piiPurgedAt: opts.piiPurgedAt ?? null,
      originalRows: {
        create: [
          { id: uuidv4(), rowNumber: 2, data: { 'Row Number': '99', 'Shopify Result': 'old', 'First Name': 'Ann', Email: 'ann@example.com' } },
          { id: uuidv4(), rowNumber: 3, data: { 'Row Number': '98', 'Shopify Result': '', 'First Name': 'Bo', Email: 'not-an-email' } },
          { id: uuidv4(), rowNumber: 4, data: { 'Row Number': '97', 'Shopify Result': '', 'First Name': 'Cy', Email: 'cy@example.com' } },
        ],
      },
    },
  });
  const importRunId = uuidv4();
  await prisma.importRun.create({
    data: {
      id: importRunId,
      validationId,
      shopDomain: 'test-store.myshopify.com',
      status: 'COMPLETED',
      rowResults: {
        create: [
          { id: uuidv4(), rowNumber: 2, accepted: true, shopifyCustomerId: 'gid://shopify/Customer/1' },
          { id: uuidv4(), rowNumber: 3, accepted: true, shopifyCustomerId: 'gid://shopify/Customer/2' },
          { id: uuidv4(), rowNumber: 4, accepted: false, shopifyCode: 'TAKEN', shopifyField: 'email', message: 'Email has already been taken' },
        ],
      },
    },
  });
  return { validationId, importRunId };
}

type Streamer = (id: string, out: PassThrough, onReady: (name: string) => void) => Promise<void>;

async function load(stream: Streamer, id: string): Promise<ExcelJS.Workbook> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  await stream(id, out, () => {});
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  return wb;
}

/** Sheet as an array of rows, each a header → value map (header row excluded). */
function table(wb: ExcelJS.Workbook, name: string): { headers: string[]; rows: string[][] } {
  const sheet = wb.getWorksheet(name)!;
  const all: string[][] = [];
  sheet.eachRow((row) => {
    const values: string[] = [];
    for (let c = 1; c <= sheet.columnCount; c++) values.push(String(row.getCell(c).value ?? ''));
    all.push(values);
  });
  return { headers: all[0], rows: all.slice(1) };
}

function cell(t: { headers: string[]; rows: string[][] }, rowIndex: number, header: string, nth = 0): string {
  const indices = t.headers.map((h, i) => (h === header ? i : -1)).filter((i) => i >= 0);
  return t.rows[rowIndex][indices[nth]];
}

runIf('customer reports (integration)', () => {
  beforeEach(resetDb);
  afterAll(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it('verification report: refuses a purged run with a 410 and the retention sentence', async () => {
    const { importRunId } = await seedRun({ piiPurgedAt: new Date('2026-09-01T00:00:00Z') });
    const err = await streamShopifyVerificationReport(importRunId, new PassThrough(), () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(410);
    expect((err as Error).message).toMatch(/deleted on 2026-09-01 under the data-retention policy/);

    const res = await request(app).get(`/api/customer-import/${importRunId}/report`);
    expect(res.status).toBe(410);
  });

  it('verification report: a CSV header named like a tool column does not overwrite it', async () => {
    const { importRunId } = await seedRun();
    const wb = await load(streamShopifyVerificationReport, importRunId);

    for (const sheetName of ['Rows With Shopify Result', 'Full Uploaded File']) {
      const t = table(wb, sheetName);
      // Tool's own Row Number first, then the CSV's column of the same name.
      expect(cell(t, 0, 'Row Number', 0), sheetName).toBe('2');
      expect(cell(t, 0, 'Row Number', 1), sheetName).toBe('99');
    }
    const rows = table(wb, 'Rows With Shopify Result');
    expect(cell(rows, 0, 'Shopify Result', 0)).toBe('Accepted');
    expect(cell(rows, 0, 'Shopify Result', 1)).toBe('old');

    const errors = table(wb, 'Errors');
    expect(errors.rows).toHaveLength(1);
    expect(cell(errors, 0, 'Row Number', 0)).toBe('4');
    expect(cell(errors, 0, 'Row Number', 1)).toBe('97');
    expect(cell(errors, 0, 'Shopify Result', 0)).toBe('Rejected');
  });

  it('verification report: the Shopify Template sheet shows what the import SENT, row-aligned', async () => {
    const { importRunId } = await seedRun({ moveInvalidContactToNotes: true });
    const wb = await load(streamShopifyVerificationReport, importRunId);
    const t = table(wb, 'Shopify Template');

    expect(t.rows.map((r) => cell({ headers: t.headers, rows: [r] }, 0, 'Row Number'))).toEqual(['2', '3', '4']);
    // Row 3's invalid email was stripped into Note before sending — the old sheet
    // showed the raw mapped value instead, which is not what Shopify received.
    expect(cell(t, 1, 'Email')).toBe('');
    expect(cell(t, 1, 'Note')).toBe('Invalid email: not-an-email');
    expect(cell(t, 1, 'Tags')).toBe('InvalidEmailNotes');
    expect(cell(t, 1, 'Shopify Result')).toBe('Accepted');
    // Add-to-Note still lands in Note; the Shopify columns are untouched otherwise.
    expect(cell(t, 0, 'Note')).toBe('old');
    expect(cell(t, 2, 'Shopify Result')).toBe('Rejected');
    expect(cell(t, 2, 'Email')).toBe('cy@example.com');
  });

  it('prevalidation report: a CSV header named "Row Number" does not overwrite the tool column', async () => {
    const { validationId } = await seedRun();
    const wb = await load(streamExcelReport, validationId);
    const t = table(wb, 'Full Uploaded File');
    expect(t.headers.slice(0, 3)).toEqual(['Row Number', 'Row Number', 'Shopify Result']);
    expect(cell(t, 0, 'Row Number', 0)).toBe('2');
    expect(cell(t, 0, 'Row Number', 1)).toBe('99');
  });

  // The template dataset sorts mapping keys into jsonb's order so a round trip
  // through validation_runs.columnMapping changes nothing. Pin that against the
  // real database, not just against our idea of how it sorts.
  it('jsonbKeyOrder matches the order Postgres hands a stored mapping back in', async () => {
    const mapping = {
      'Segment Name': 'Add to Note',
      Rep: 'Add to Note',
      Comments: 'Add to Note',
      'Ünïcode Col': 'Add to Tags',
      Zz: 'Keep',
      'Customer Email': 'Email',
    };
    const id = uuidv4();
    await prisma.validationRun.create({
      data: { id, fileName: 'x.csv', totalRows: 0, errors: 0, columnMapping: mapping },
    });
    const run = await prisma.validationRun.findUniqueOrThrow({ where: { id } });
    expect(Object.keys(run.columnMapping as object)).toEqual(Object.keys(mapping).sort(jsonbKeyOrder));
  });

  it('validation no longer writes an affectedRows snapshot of the flagged rows', async () => {
    const preview = await request(app)
      .post('/api/customer-validation/preview')
      .attach('file', Buffer.from('First Name,Email\nAnn,not-an-email\n'), { filename: 'c.csv', contentType: 'text/csv' });
    const validate = await request(app)
      .post('/api/customer-validation/validate')
      .send({ uploadId: preview.body.uploadId, columnMapping: preview.body.suggestedMapping });
    expect(validate.status).toBe(200);
    expect(validate.body.errors).toBe(1);
    const run = await prisma.validationRun.findUniqueOrThrow({ where: { id: validate.body.validationId } });
    expect(run.affectedRows).toEqual([]);
  });

  it('validate rejects a Keep column that collides with another column\'s target', async () => {
    const preview = await request(app)
      .post('/api/customer-validation/preview')
      .attach('file', Buffer.from('Comments,Note,Email\nhi,there,a@example.com\n'), { filename: 'c.csv', contentType: 'text/csv' });
    const validate = await request(app)
      .post('/api/customer-validation/validate')
      .send({ uploadId: preview.body.uploadId, columnMapping: { Comments: 'Note', Note: 'Keep', Email: 'Email' } });
    expect(validate.status).toBe(400);
    expect(validate.body.error).toMatch(/"Note" is set to Keep/);
  });
});
