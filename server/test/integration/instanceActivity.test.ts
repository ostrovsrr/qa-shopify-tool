import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../src/index';
import prisma from '../../src/db/prisma';
import { resetShopifyConfigCache } from '../../src/config/shopify';
import { acquireStoreLock, shareOwner, StoreLockOwner } from '../../src/services/storeLock.service';
import { resetActivityTracking } from '../../src/services/instanceActivity.service';
import { resetDb } from './resetDb';

// acquire must run inside a transaction: its advisory lock is transaction-scoped.
const lockStore = (storeId: string, owner: StoreLockOwner) =>
  prisma.$transaction((tx) => acquireStoreLock(tx, storeId, owner));

// GET /api/instance/activity feeds the fleet status page: how much has this
// instance's SE run, and what is running on their stores right now.
//
// Runs are counted by typed name (case-insensitive, like the history filter).
// What is RUNNING is attributed by STORE, because each instance only holds its
// own SE's stores — so a colleague's import on another store never shows here.
const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const OURS = 'ours-qa';
const THEIRS = 'theirs-qa';

async function customerRun(createdBy: string, createdAt = new Date()): Promise<string> {
  const id = uuidv4();
  await prisma.validationRun.create({
    data: { id, createdBy, fileName: 'c.csv', fileType: 'CUSTOMER', totalRows: 1, errors: 0, createdAt },
  });
  return id;
}

async function productUpload(createdBy: string): Promise<string> {
  const id = uuidv4();
  await prisma.productUploadRun.create({ data: { id, createdBy, fileName: 'p.csv', productCount: 1 } });
  return id;
}

runIf('GET /api/instance/activity', () => {
  beforeEach(async () => {
    await resetDb();
    resetActivityTracking();
    process.env.QA_INSTANCE_OWNER = 'Josh';
    // apiVersion is explicit because setEnv blanks SHOPIFY_API_VERSION, and a blank
    // version fails validation — which resolves to zero stores, not an error.
    process.env.SHOPIFY_TEST_STORES = JSON.stringify([
      { id: OURS, label: 'Ours', shop: 'ours-qa.myshopify.com', adminToken: 'shpat_ours', apiVersion: '2026-01' },
    ]);
    resetShopifyConfigCache();
  });

  afterEach(() => {
    delete process.env.QA_INSTANCE_OWNER;
    process.env.SHOPIFY_TEST_STORES = '[]';
    resetShopifyConfigCache();
  });

  afterAll(() => prisma.$disconnect());

  it("counts the owner's runs case-insensitively, and nobody else's", async () => {
    const mine = await customerRun('Josh');
    await customerRun('josh', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    await customerRun('Luigi');
    await prisma.importRun.create({
      data: { validationId: mine, shopDomain: 'ours-qa.myshopify.com', status: 'COMPLETED' },
    });
    const upload = await productUpload('JOSH');
    await prisma.productImportRun.create({
      data: { uploadId: upload, shopDomain: 'ours-qa.myshopify.com', status: 'COMPLETED' },
    });

    const res = await request(app).get('/api/instance/activity');

    expect(res.status).toBe(200);
    expect(res.body.owner).toBe('Josh');
    expect(res.body.runs).toEqual({
      customerValidations: { total: 2, last7d: 1 },
      customerImports: { total: 1, last7d: 1 },
      productUploads: { total: 1, last7d: 1 },
      productImports: { total: 1, last7d: 1 },
    });
    expect(res.body.active).toEqual([]);
  });

  it('has no run counts when the instance has no owner', async () => {
    delete process.env.QA_INSTANCE_OWNER;
    const res = await request(app).get('/api/instance/activity');
    expect(res.body.owner).toBeNull();
    expect(res.body.runs).toBeNull();
  });

  it('lists an import running on OUR store, watched while its lock is live', async () => {
    const upload = await productUpload('Josh');
    const run = await prisma.productImportRun.create({
      data: { uploadId: upload, shopDomain: 'ours-qa.myshopify.com', storeId: OURS, status: 'RUNNING' },
    });
    await lockStore(OURS, {
      ownerType: 'PRODUCT_IMPORT_RUN',
      ownerId: run.id,
      operation: 'a product import',
    });

    const res = await request(app).get('/api/instance/activity');

    expect(res.body.active).toMatchObject([
      { storeId: OURS, shop: 'ours-qa.myshopify.com', operation: 'product import', stale: false },
    ]);
  });

  it('still lists an import nobody is watching, flagged stale, after its lock has gone', async () => {
    // The lock TTL is a backstop so an unwatched run cannot wedge a store; it does
    // NOT mean the run finished. It is still running at Shopify, so it must still
    // show — as unwatched.
    const upload = await productUpload('Josh');
    await prisma.productImportRun.create({
      data: { uploadId: upload, shopDomain: 'ours-qa.myshopify.com', storeId: OURS, status: 'RUNNING' },
    });

    const res = await request(app).get('/api/instance/activity');
    expect(res.body.active).toMatchObject([{ storeId: OURS, operation: 'product import', stale: true }]);
  });

  it("ignores runs on another SE's store and finished runs on ours", async () => {
    const v = await customerRun('Josh');
    await prisma.importRun.create({
      data: { validationId: v, shopDomain: 'theirs-qa.myshopify.com', storeId: THEIRS, status: 'RUNNING' },
    });
    await prisma.importRun.create({
      data: { validationId: v, shopDomain: 'ours-qa.myshopify.com', storeId: OURS, status: 'COMPLETED' },
    });

    const res = await request(app).get('/api/instance/activity');
    expect(res.body.active).toEqual([]);
  });

  it('lists a batch per store, with that store slice size', async () => {
    const v = await customerRun('Josh');
    const parent = await prisma.importRun.create({
      data: { validationId: v, shopDomain: 'ours-qa.myshopify.com, theirs-qa.myshopify.com', status: 'RUNNING' },
    });
    for (const [storeId, batchIndex] of [[OURS, 0], [THEIRS, 1]] as const) {
      await prisma.importBatchJob.create({
        data: {
          importRunId: parent.id,
          storeId,
          shopDomain: `${storeId}.myshopify.com`,
          batchIndex,
          batchCount: 2,
          rowCount: 500,
          status: 'RUNNING',
        },
      });
    }

    const res = await request(app).get('/api/instance/activity');
    expect(res.body.active).toMatchObject([{ storeId: OURS, operation: 'customer import', size: 500 }]);
  });

  // A store runs up to k jobs of one run; the SE sees ONE operation per store.
  it("folds a store's jobs into one entry: summed size, earliest start, watched by its share lock", async () => {
    const upload = await productUpload('Josh');
    const parent = await prisma.productImportRun.create({
      data: { uploadId: upload, shopDomain: 'ours-qa.myshopify.com', status: 'RUNNING' },
    });
    const first = new Date(Date.now() - 60_000);
    for (const [batchIndex, productCount, createdAt] of [[0, 30, new Date()], [1, 12, first], [2, 8, new Date()]] as const) {
      await prisma.productImportJob.create({
        data: {
          importRunId: parent.id,
          storeId: OURS,
          shopDomain: 'ours-qa.myshopify.com',
          batchIndex,
          batchCount: 3,
          productCount,
          status: 'RUNNING',
          createdAt,
        },
      });
    }
    await lockStore(OURS, {
      ownerType: 'PRODUCT_IMPORT_STORE_SHARE',
      ownerId: shareOwner(parent.id, OURS),
      operation: 'a product import',
    });

    const res = await request(app).get('/api/instance/activity');

    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0]).toMatchObject({
      storeId: OURS,
      operation: 'product import',
      size: 50,
      startedAt: first.toISOString(),
      stale: false,
    });
  });

  it("moves last-active on the SE's own requests, never on the monitor's probes", async () => {
    await request(app).get('/api/health');
    await request(app).get('/api/instance');
    const idle = await request(app).get('/api/instance/activity');
    expect(idle.body.lastRequestAt).toBeNull();

    await request(app).get('/api/shopify/stores');
    const busy = await request(app).get('/api/instance/activity');
    expect(typeof busy.body.lastRequestAt).toBe('string');
  });
});
