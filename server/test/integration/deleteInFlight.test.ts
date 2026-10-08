import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../src/index';
import prisma from '../../src/db/prisma';
import {
  DELETE_WHILE_CLEANING,
  DELETE_WHILE_IMPORTING,
} from '../../src/services/customerValidation.service';
import { resetDb } from './resetDb';

// ─────────────────────────────────────────────────────────────────────────────
// DELETING A RUN WHILE ITS IMPORT IS STILL RUNNING.
//
// Deleting a validation run / product upload cascades to its import runs and batch
// jobs. Delete a RUNNING one and its store lock's holder row vanishes; the lock then
// reads "nothing is running" and the store is handed to the next colleague while
// Shopify is still executing the bulk op. So the delete is refused (409) while any
// import of the run — the single run or any batch job — is non-terminal, or while a
// cleanup reversing one of its imports is. Customers and products are twins.
// ─────────────────────────────────────────────────────────────────────────────

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

async function seedValidation(): Promise<string> {
  const id = uuidv4();
  await prisma.validationRun.create({
    data: { id, fileName: 'customers.csv', fileType: 'CUSTOMER', totalRows: 1, errors: 0 },
  });
  return id;
}

async function seedCustomerImport(
  validationId: string,
  status: string,
  jobStatuses: string[] = [],
): Promise<string> {
  const id = uuidv4();
  await prisma.importRun.create({
    data: {
      id,
      validationId,
      storeId: jobStatuses.length ? null : 'store1',
      shopDomain: 'fake.myshopify.com',
      status,
      batchJobs: {
        create: jobStatuses.map((s, i) => ({
          storeId: `store${i + 1}`,
          shopDomain: 'fake.myshopify.com',
          batchIndex: i,
          batchCount: jobStatuses.length,
          status: s,
        })),
      },
    },
  });
  return id;
}

async function seedUpload(): Promise<string> {
  const id = uuidv4();
  await prisma.productUploadRun.create({
    data: { id, fileName: 'products.csv', productCount: 1 },
  });
  return id;
}

async function seedProductImport(
  uploadId: string,
  status: string,
  jobStatuses: string[] = [],
): Promise<string> {
  const id = uuidv4();
  await prisma.productImportRun.create({
    data: {
      id,
      uploadId,
      storeId: jobStatuses.length ? null : 'store1',
      shopDomain: 'fake.myshopify.com',
      status,
      batchJobs: {
        create: jobStatuses.map((s, i) => ({
          storeId: `store${i + 1}`,
          shopDomain: 'fake.myshopify.com',
          batchIndex: i,
          batchCount: jobStatuses.length,
          status: s,
        })),
      },
    },
  });
  return id;
}

const seedCleanup = (importRunId: string, status: string) =>
  prisma.cleanupRun.create({
    data: {
      entity: 'CUSTOMER',
      storeId: 'store1',
      shopDomain: 'fake.myshopify.com',
      tag: `qa-import-${importRunId}`,
      importRunId,
      status,
    },
  });

runIf('deleting a run with work still in flight', () => {
  beforeEach(resetDb);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── customers ─────────────────────────────────────────────────────────────
  const deleteValidation = (id: string) =>
    request(app).delete(`/api/customer-validation/${id}`);
  const validationExists = async (id: string) =>
    (await prisma.validationRun.count({ where: { id } })) === 1;

  it('refuses to delete a validation run whose single-store import is RUNNING', async () => {
    const id = await seedValidation();
    await seedCustomerImport(id, 'RUNNING');

    const res = await deleteValidation(id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(DELETE_WHILE_IMPORTING);
    expect(await validationExists(id)).toBe(true);
  });

  it('refuses while any batch job is still PENDING, even if the parent reads terminal', async () => {
    const id = await seedValidation();
    await seedCustomerImport(id, 'COMPLETED', ['COMPLETED', 'PENDING']);

    expect((await deleteValidation(id)).status).toBe(409);
    expect(await validationExists(id)).toBe(true);
  });

  it('refuses while a cleanup reversing one of its imports is RUNNING', async () => {
    const id = await seedValidation();
    const importId = await seedCustomerImport(id, 'COMPLETED');
    await seedCleanup(importId, 'RUNNING');

    const res = await deleteValidation(id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(DELETE_WHILE_CLEANING);
  });

  // A cleanup split into several bulk deletes stays RUNNING on its run until the last
  // op is terminal, so one finished op must not open the door.
  it('refuses while a cleanup still has a delete op running', async () => {
    const id = await seedValidation();
    const importId = await seedCustomerImport(id, 'COMPLETED');
    const cleanup = await seedCleanup(importId, 'RUNNING');
    await prisma.cleanupOp.createMany({
      data: [
        { cleanupRunId: cleanup.id, opIndex: 0, opCount: 2, status: 'COMPLETED', bulkOperationId: 'gid://shopify/BulkOperation/1' },
        { cleanupRunId: cleanup.id, opIndex: 1, opCount: 2, status: 'RUNNING', bulkOperationId: 'gid://shopify/BulkOperation/2' },
      ],
    });

    const res = await deleteValidation(id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(DELETE_WHILE_CLEANING);
    expect(await validationExists(id)).toBe(true);
  });

  it('deletes once everything has finished', async () => {
    const id = await seedValidation();
    const importId = await seedCustomerImport(id, 'FAILED', ['COMPLETED', 'FAILED']);
    await seedCleanup(importId, 'COMPLETED');

    expect((await deleteValidation(id)).status).toBe(200);
    expect(await validationExists(id)).toBe(false);
  });

  it('still answers 404 for a run that does not exist', async () => {
    expect((await deleteValidation(uuidv4())).status).toBe(404);
  });

  // ── products (the twin) ───────────────────────────────────────────────────
  const deleteUpload = (id: string) => request(app).delete(`/api/product-upload/${id}`);
  const uploadExists = async (id: string) =>
    (await prisma.productUploadRun.count({ where: { id } })) === 1;

  it('refuses to delete an upload whose import is PENDING', async () => {
    const id = await seedUpload();
    await seedProductImport(id, 'PENDING');

    const res = await deleteUpload(id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(DELETE_WHILE_IMPORTING);
    expect(await uploadExists(id)).toBe(true);
  });

  it('refuses while any product batch job is still RUNNING', async () => {
    const id = await seedUpload();
    await seedProductImport(id, 'RUNNING', ['COMPLETED', 'RUNNING']);

    expect((await deleteUpload(id)).status).toBe(409);
    expect(await uploadExists(id)).toBe(true);
  });

  it('refuses while a product cleanup of one of its imports is PENDING', async () => {
    const id = await seedUpload();
    const importId = await seedProductImport(id, 'COMPLETED');
    await seedCleanup(importId, 'PENDING');

    const res = await deleteUpload(id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(DELETE_WHILE_CLEANING);
  });

  it('deletes an upload once everything has finished', async () => {
    const id = await seedUpload();
    await seedProductImport(id, 'COMPLETED', ['COMPLETED', 'EXPIRED']);

    expect((await deleteUpload(id)).status).toBe(200);
    expect(await uploadExists(id)).toBe(false);
  });

  it('still answers 404 for an upload that does not exist', async () => {
    expect((await deleteUpload(uuidv4())).status).toBe(404);
  });
});
