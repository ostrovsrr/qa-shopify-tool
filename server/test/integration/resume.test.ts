import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// RESUME-ON-BOOT, end to end against a real database.
//
// The pre-persist fix stopped the tool lying, but on its own it traded a wrong
// answer for a permanent hang: a row whose bulk op never got submitted sits
// PENDING forever. This is what finishes those rows.
//
// Covered here: adopt (the op DID reach Shopify), relaunch (it did not), and the
// claim race (two overlapping boots must not both work the same row — that is how
// you end up submitting two bulk ops for one job).
// ─────────────────────────────────────────────────────────────────────────────

let currentOp: {
  id: string;
  status: string;
  errorCode: null;
  objectCount: string;
  url: null;
  partialDataUrl: null;
  createdAt: string;
} | null = null;

const submitted: string[] = [];

const fakeClient = {
  shop: 'fake.myshopify.com',
  verifyConnection: async () => ({ ok: true, shop: 'fake.myshopify.com' }),
  query: async () => ({ locations: { nodes: [{ id: 'gid://shopify/Location/1' }] } }),
};

vi.mock('../../src/services/shopifyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyClient')>();
  return { ...actual, getShopifyClient: async () => fakeClient };
});

vi.mock('../../src/services/shopifyBulk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyBulk')>();
  return {
    ...actual,
    fetchCurrentBulkOperation: async () => currentOp,
    stagedUpload: async () => 'staged/path',
    runBulkMutation: async () => {
      const id = `gid://shopify/BulkOperation/relaunched-${submitted.length + 1}`;
      submitted.push(id);
      return id;
    },
  };
});

const prisma = (await import('../../src/db/prisma')).default;
const { resetDb } = await import('./resetDb');
const { resumeStore } = await import('../../src/services/importResume.service');
const { productResumableStores } = await import('../../src/services/productImport.service');

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const jobStore = () => productResumableStores().find((s) => s.label === 'product-job')!;

/** An upload + a batch parent with one PENDING job that never got its op submitted. */
async function seedPendingJob(): Promise<{ jobId: string; parentId: string }> {
  const uploadId = uuidv4();
  await prisma.productUploadRun.create({
    data: {
      id: uploadId,
      fileName: 'p.csv',
      productCount: 2,
      originalRows: {
        create: [
          { id: uuidv4(), rowNumber: 1, data: { Handle: 'alpha', Title: 'Alpha' } },
          { id: uuidv4(), rowNumber: 2, data: { Handle: 'beta', Title: 'Beta' } },
        ],
      },
    },
  });

  const parentId = uuidv4();
  const jobId = uuidv4();
  await prisma.productImportRun.create({
    data: {
      id: parentId,
      uploadId,
      storeId: null,
      shopDomain: 'fake.myshopify.com',
      status: 'RUNNING',
      batchJobs: {
        create: [
          {
            id: jobId,
            storeId: 'store1',
            shopDomain: 'fake.myshopify.com',
            batchIndex: 0,
            batchCount: 1,
            bulkOperationId: null,
            status: 'PENDING',
            productCount: 2,
          },
        ],
      },
    },
  });
  return { jobId, parentId };
}

const job = async (id: string) => prisma.productImportJob.findUniqueOrThrow({ where: { id } });

runIf('resume-on-boot', () => {
  beforeEach(async () => {
    currentOp = null;
    submitted.length = 0;
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── ADOPT ─────────────────────────────────────────────────────────────────
  // The op DID reach Shopify; we died before saving its id. Shopify allows one
  // bulk op per shop, so the shop's current op — created after our row — is ours.
  // Adopting recovers it. Re-submitting would hit the per-shop limit, or duplicate
  // the import if the first op had already finished.
  it('adopts the in-flight bulk op the crashed process had already submitted', async () => {
    const { jobId } = await seedPendingJob();
    const row = await job(jobId);

    currentOp = {
      id: 'gid://shopify/BulkOperation/inflight',
      status: 'RUNNING',
      errorCode: null,
      objectCount: '2',
      url: null,
      partialDataUrl: null,
      createdAt: new Date(row.createdAt.getTime() + 5_000).toISOString(),
    };

    const summary = await resumeStore(jobStore());

    expect(summary).toMatchObject({ adopted: 1, relaunched: 0, failed: 0 });
    const after = await job(jobId);
    expect(after.status).toBe('RUNNING');
    expect(after.bulkOperationId).toBe('gid://shopify/BulkOperation/inflight');
    // Crucially: we did NOT submit a second operation.
    expect(submitted).toEqual([]);
  });

  it('adopts an op that COMPLETED during the downtime, rather than importing twice', async () => {
    const { jobId } = await seedPendingJob();
    const row = await job(jobId);

    currentOp = {
      id: 'gid://shopify/BulkOperation/finished',
      status: 'COMPLETED',
      errorCode: null,
      objectCount: '2',
      url: null,
      partialDataUrl: null,
      createdAt: new Date(row.createdAt.getTime() + 1_000).toISOString(),
    };

    const summary = await resumeStore(jobStore());

    expect(summary.adopted).toBe(1);
    expect((await job(jobId)).bulkOperationId).toBe('gid://shopify/BulkOperation/finished');
    // The records are already in the store. A relaunch here would duplicate the
    // entire merchant import.
    expect(submitted).toEqual([]);
  });

  // ── RELAUNCH ──────────────────────────────────────────────────────────────
  it('relaunches a job whose op never reached Shopify (no current op)', async () => {
    const { jobId } = await seedPendingJob();
    currentOp = null;

    const summary = await resumeStore(jobStore());

    expect(summary).toMatchObject({ adopted: 0, relaunched: 1, failed: 0 });
    const after = await job(jobId);
    expect(after.status).toBe('RUNNING');
    expect(after.bulkOperationId).toBe('gid://shopify/BulkOperation/relaunched-1');
    expect(submitted).toHaveLength(1);
  });

  it('relaunches when the shop op predates the row (it belongs to an earlier run)', async () => {
    const { jobId } = await seedPendingJob();
    const row = await job(jobId);

    currentOp = {
      id: 'gid://shopify/BulkOperation/someone-elses',
      status: 'COMPLETED',
      errorCode: null,
      objectCount: '99',
      url: null,
      partialDataUrl: null,
      createdAt: new Date(row.createdAt.getTime() - 60_000).toISOString(),
    };

    const summary = await resumeStore(jobStore());

    expect(summary.relaunched).toBe(1);
    // Must NOT have adopted a stranger's operation — that would attribute someone
    // else's results to this run.
    expect((await job(jobId)).bulkOperationId).toBe('gid://shopify/BulkOperation/relaunched-1');
  });

  // ── THE CLAIM ─────────────────────────────────────────────────────────────
  it('resolves each row exactly once, even if resume runs twice (rolling deploy)', async () => {
    const { jobId } = await seedPendingJob();
    currentOp = null;

    await resumeStore(jobStore());
    const secondPass = await resumeStore(jobStore());

    // The row is no longer PENDING, so the second boot finds nothing to do.
    expect(secondPass).toMatchObject({ adopted: 0, relaunched: 0, failed: 0 });
    // Exactly ONE bulk op was ever submitted for this job.
    expect(submitted).toHaveLength(1);
    expect((await job(jobId)).status).toBe('RUNNING');
  });

  it('leaves terminal and RUNNING rows alone — only PENDING is resumable', async () => {
    const { jobId } = await seedPendingJob();
    await prisma.productImportJob.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', bulkOperationId: 'gid://done' },
    });

    const summary = await resumeStore(jobStore());

    expect(summary).toMatchObject({ adopted: 0, relaunched: 0, failed: 0, skipped: 0 });
    expect(submitted).toEqual([]);
  });
});
