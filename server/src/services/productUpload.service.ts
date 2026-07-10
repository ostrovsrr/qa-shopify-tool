import { v4 as uuidv4 } from 'uuid';
import prisma from '../db/prisma';
import { parseProductCsvBuffer } from './productCsvParser';
import { ProductHistoryItem, UpdateUploadMetadata } from '../types';

// Thin upload: parse the product CSV, group by Handle for the product count, and
// persist the run + its raw rows. No validation, no column mapping — the CSV is
// already in Shopify template format and the import is the truth.

export interface UploadSummary {
  uploadId: string;
  fileName: string;
  productCount: number;
  rowCount: number;
  headers: string[];
}

export async function createProductUpload(
  buffer: Buffer,
  fileName: string,
): Promise<UploadSummary> {
  const parsed = await parseProductCsvBuffer(buffer);
  const uploadId = uuidv4();

  await prisma.productUploadRun.create({
    data: {
      id: uploadId,
      fileName,
      productCount: parsed.groups.length,
      originalColumns: parsed.headers,
    },
  });

  if (parsed.rows.length > 0) {
    await prisma.productOriginalRow.createMany({
      data: parsed.rows.map((r) => ({
        id: uuidv4(),
        uploadRunId: uploadId,
        rowNumber: r.rowNumber,
        data: r.original,
      })),
    });
  }

  return {
    uploadId,
    fileName,
    productCount: parsed.groups.length,
    rowCount: parsed.rows.length,
    headers: parsed.headers,
  };
}

export interface UploadDetail {
  id: string;
  fileName: string;
  productCount: number;
  rowCount: number;
  ticketNumber: string | null;
  ticketName: string | null;
  comments: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function getUploadRun(uploadId: string): Promise<UploadDetail | null> {
  const upload = await prisma.productUploadRun.findUnique({
    where: { id: uploadId },
    include: { _count: { select: { originalRows: true } } },
  });
  if (!upload) return null;
  return {
    id: upload.id,
    fileName: upload.fileName,
    productCount: upload.productCount,
    rowCount: upload._count.originalRows,
    ticketNumber: upload.ticketNumber,
    ticketName: upload.ticketName,
    comments: upload.comments,
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
  };
}

// Pull the most recent import per upload so History can flag "imported" + outcome.
const lastImportSelect = {
  orderBy: { createdAt: 'desc' },
  take: 1,
  select: { status: true, successCount: true, errorCount: true, createdAt: true },
} as const;

export async function getUploadHistory(): Promise<ProductHistoryItem[]> {
  const uploads = await prisma.productUploadRun.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      fileName: true,
      productCount: true,
      ticketNumber: true,
      ticketName: true,
      comments: true,
      createdAt: true,
      updatedAt: true,
      importRuns: lastImportSelect,
    },
  });
  return uploads.map(({ importRuns, ...upload }) => ({
    ...upload,
    lastImport: importRuns[0] ?? null,
  }));
}

export async function updateUploadMetadata(
  uploadId: string,
  data: UpdateUploadMetadata,
): Promise<ProductHistoryItem | null> {
  const exists = await prisma.productUploadRun.findUnique({ where: { id: uploadId } });
  if (!exists) return null;
  const upload = await prisma.productUploadRun.update({
    where: { id: uploadId },
    data,
    select: {
      id: true,
      fileName: true,
      productCount: true,
      ticketNumber: true,
      ticketName: true,
      comments: true,
      createdAt: true,
      updatedAt: true,
      importRuns: lastImportSelect,
    },
  });
  const { importRuns, ...rest } = upload;
  return { ...rest, lastImport: importRuns[0] ?? null };
}

export async function deleteUploadRun(uploadId: string): Promise<boolean> {
  const exists = await prisma.productUploadRun.findUnique({ where: { id: uploadId } });
  if (!exists) return false;
  // Cascades to originalRows, importRuns, their results + batch jobs.
  await prisma.productUploadRun.delete({ where: { id: uploadId } });
  return true;
}
