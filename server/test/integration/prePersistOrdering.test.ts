import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// PROVES THE ORDERING: the run row is on disk BEFORE the bulk op is submitted.
//
// The other suites show that an unreachable store leaves no orphan run. That is
// necessary but not sufficient — it fails before the pre-persist even runs, so it
// says nothing about ordering.
//
// The invariant that actually matters: the row must exist EVEN WHEN THE SUBMIT
// FAILS. So here Shopify is reachable (fake client), the pre-persist happens, and
// then the bulk submit blows up. If the row is on disk in FAILED state with no op
// id, the write must have preceded the submit. If the code ever regresses to
// "submit, then create", this suite finds zero rows and goes red.
//
// Why it matters: a bulk op creates REAL customers/products in a REAL store. If it
// is submitted before the row exists, a crash in between leaves those records in
// the store tagged qa-import-<importRunId> — an id that only ever lived in memory.
// Untracked, unreconcilable, invisible to the run-scoped cleanup.
//
// Never take a side effect you have not recorded.
// ─────────────────────────────────────────────────────────────────────────────

// A client that is healthy and answers the location query, so the code reaches the
// staged upload — which then fails.
const fakeClient = {
  shop: 'fake.myshopify.com',
  verifyConnection: async () => ({ ok: true, shop: 'fake.myshopify.com' }),
  query: async () => ({
    locations: { nodes: [{ id: 'gid://shopify/Location/1' }] },
  }),
};

vi.mock('../../src/services/shopifyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyClient')>();
  return { ...actual, getShopifyClient: async () => fakeClient };
});

vi.mock('../../src/services/shopifyBulk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyBulk')>();
  return {
    ...actual,
    // The submit fails. Anything already written must still be on disk.
    stagedUpload: async () => {
      throw new Error('staged upload exploded');
    },
  };
});

const prisma = (await import('../../src/db/prisma')).default;
const { startProductImport } = await import('../../src/services/productImport.service');
const { startCustomerImport } = await import('../../src/services/shopifyImport.service');

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

runIf('pre-persist ordering — the row lands before the bulk op is submitted', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "product_upload_runs" RESTART IDENTITY CASCADE',
    );
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "validation_runs" RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('products: the run row exists in FAILED state even though the submit blew up', async () => {
    const uploadId = uuidv4();
    await prisma.productUploadRun.create({
      data: {
        id: uploadId,
        fileName: 'p.csv',
        productCount: 1,
        originalRows: {
          create: [{ id: uuidv4(), rowNumber: 1, data: { Handle: 'a', Title: 'A' } }],
        },
      },
    });

    const result = await startProductImport(uploadId, 'store1');
    expect(result).toMatchObject({ ok: false });

    // THE ASSERTION. The submit failed, but the row is here — so it was written
    // first. Under the old "submit then create" order this array would be empty.
    const runs = await prisma.productImportRun.findMany({ where: { uploadId } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('FAILED');
    expect(runs[0].bulkOperationId).toBeNull();
    expect(runs[0].error).toContain('staged upload exploded');
  });

  it('customers: the run row exists in FAILED state even though the submit blew up', async () => {
    const validationId = uuidv4();
    await prisma.validationRun.create({
      data: {
        id: validationId,
        fileName: 'c.csv',
        fileType: 'CUSTOMER',
        totalRows: 1,
        errors: 0,
        warnings: 0,
        info: 0,
        originalRows: {
          create: [
            {
              id: uuidv4(),
              rowNumber: 2,
              data: { 'First Name': 'Ann', 'Last Name': 'Lee', Email: 'ann@example.com' },
            },
          ],
        },
      },
    });

    const result = await startCustomerImport(validationId, 'store1');
    expect(result).toMatchObject({ ok: false });

    const runs = await prisma.importRun.findMany({ where: { validationId } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('FAILED');
    expect(runs[0].bulkOperationId).toBeNull();
    expect(runs[0].error).toContain('staged upload exploded');
  });
});
