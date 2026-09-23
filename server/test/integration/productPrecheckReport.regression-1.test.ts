import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import ExcelJS from 'exceljs';
import prisma from '../../src/db/prisma';
import { streamProductPrecheckReport } from '../../src/reports/productImportReport';
import { resetDb } from './resetDb';

// Regression: ISSUE-003 — the pre-check report labelled every row of an upload
// made BEFORE the pre-check existed (precheckErrors = null) as "Imports": no
// issues were stored because nothing was checked, and the report read that as
// "clean". A confident wrong answer about a file nobody looked at.
// Found by /qa on 2026-09-22
// Report: .gstack/qa-reports/qa-report-localhost-2026-09-22.md

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

async function seedUpload(precheckErrors: number | null): Promise<string> {
  const id = uuidv4();
  await prisma.productUploadRun.create({
    data: {
      id,
      fileName: 'products.csv',
      productCount: 2,
      originalColumns: ['Handle', 'Title'],
      precheckErrors,
      originalRows: {
        create: [
          { id: uuidv4(), rowNumber: 2, data: { Handle: 'alpha', Title: 'Alpha' } },
          { id: uuidv4(), rowNumber: 3, data: { Handle: 'beta', Title: '' } },
        ],
      },
    },
  });
  return id;
}

async function expectedResults(uploadId: string): Promise<string[]> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  await streamProductPrecheckReport(uploadId, out, () => {});
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  const sheet = wb.getWorksheet('Full Uploaded File')!;
  const results: string[] = [];
  sheet.eachRow((row, i) => {
    if (i > 1) results.push(String(row.getCell(2).value));
  });
  return results;
}

runIf('pre-check report: Expected Result', () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it('says "Not checked" for an upload that predates the pre-check', async () => {
    const id = await seedUpload(null);
    expect(await expectedResults(id)).toEqual(['Not checked', 'Not checked']);
  });

  it('still says Imports / Rejected for a checked upload', async () => {
    const id = await seedUpload(1);
    await prisma.productValidationIssue.create({
      data: {
        id: uuidv4(),
        uploadRunId: id,
        rowNumber: 3,
        handle: 'beta',
        columnName: 'Title',
        severity: 'Error',
        issueType: 'MissingTitle',
        currentValue: '',
        message: 'Product "beta" has no Title on its first row.',
        suggestedFix: 'Fill in the Title.',
      },
    });
    expect(await expectedResults(id)).toEqual(['Imports', 'Rejected']);
  });
});
