import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// RESUME-ON-BOOT, end to end against a real database.
//
// The pre-persist fix stopped the tool lying, but on its own it traded a wrong
// answer for a permanent hang: a row whose bulk op never got submitted sits
// PENDING forever. This is what finishes those rows.
//
// Covered here: relaunch (the submit was provably never attempted), fail (it was
// attempted, so its outcome is unknown and must not be guessed), two such rows on
// one store, the intent marker landing BEFORE the mutation, and the claim race (two
// overlapping boots must not both work the same row).
//
// Nothing here fakes "the shop's current operation": resume no longer asks. From API
// 2026-01 a shop runs up to five bulk mutations at once, so the shop's newest op was
// never evidence of which one is ours.
// ─────────────────────────────────────────────────────────────────────────────

/** Bulk op ids handed out by the fake submit, in order. */
const submitted: string[] = [];
/** submitAttemptedAt of every PENDING job/cleanup at the moment each mutation ran. */
const attemptSeenAtSubmit: (Date | null)[] = [];

/** What a cleanup's tag lookup finds in the (fake) store, and how often it looked. */
let taggedIds: string[] = [];
let tagListings = 0;

const fakeClient = {
  shop: 'fake.myshopify.com',
  verifyConnection: async () => ({ ok: true, shop: 'fake.myshopify.com' }),
  query: async (q: string) => {
    // Tag lookup (the `products`/`customers` connection) — cleanup listing its ids.
    if (q.includes('pageInfo')) {
      tagListings++;
      const key = q.includes('products') ? 'products' : 'customers';
      return {
        [key]: {
          nodes: taggedIds.map((id) => ({ id })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    return { locations: { nodes: [{ id: 'gid://shopify/Location/1' }] } };
  },
};

vi.mock('../../src/services/shopifyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyClient')>();
  return { ...actual, getShopifyClient: async () => fakeClient };
});

/** When set, every store id resolves to itself, so resume really takes the store's
 *  lock (with no store configured — setEnv.ts — it resolves nothing and skips it). */
let storesResolve = false;
vi.mock('../../src/config/shopify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/shopify')>();
  return {
    ...actual,
    resolveStoreId: (id?: string) => (storesResolve ? (id ?? null) : actual.resolveStoreId(id)),
  };
});

async function recordSubmit(attempt: Date | null): Promise<string> {
  attemptSeenAtSubmit.push(attempt);
  const id = `gid://shopify/BulkOperation/relaunched-${submitted.length + 1}`;
  submitted.push(id);
  return id;
}

vi.mock('../../src/services/shopifyBulk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyBulk')>();
  return {
    ...actual,
    stagedUpload: async () => 'staged/path',
    runBulkMutation: async () => {
      // Which row is submitting right now? The one resume just claimed and is
      // relaunching — the only PENDING product job with a live claim.
      const row = await prisma.productImportJob.findFirst({
        where: { status: 'PENDING', claimedAt: { not: null }, submitAttemptedAt: { not: null } },
        orderBy: { submitAttemptedAt: 'desc' },
      });
      return recordSubmit(row?.submitAttemptedAt ?? null);
    },
    submitBulkDelete: async (
      _client: unknown,
      _ids: string[],
      _spec: unknown,
      beforeRun?: () => Promise<void>,
    ) => {
      if (beforeRun) await beforeRun();
      const row = await prisma.cleanupRun.findFirst({ where: { status: 'PENDING' } });
      return recordSubmit(row?.submitAttemptedAt ?? null);
    },
  };
});

const prisma = (await import('../../src/db/prisma')).default;
const { resetDb } = await import('./resetDb');
const { resumeStore, SUBMIT_OUTCOME_UNKNOWN } = await import(
  '../../src/services/importResume.service'
);
const { productResumableStores } = await import('../../src/services/productImport.service');
const { cleanupResumableStores } = await import('../../src/services/cleanupRun.service');
const { customerResumableStores } = await import('../../src/services/shopifyImport.service');
const { shareOwner } = await import('../../src/services/storeLock.service');

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const jobStore = () => productResumableStores().find((s) => s.label === 'product-job')!;
const cleanupStore = () => cleanupResumableStores()[0];
const customerJobStore = () => customerResumableStores().find((s) => s.label === 'customer-job')!;

interface JobSeed {
  submitAttemptedAt?: Date | null;
}

/**
 * An upload + a batch parent whose PENDING jobs all target the SAME store — the
 * shape a crash mid-fan-out leaves when two operations were live on one shop.
 */
async function seedPendingJobs(seeds: JobSeed[] = [{}]): Promise<string[]> {
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

  const jobIds = seeds.map(() => uuidv4());
  await prisma.productImportRun.create({
    data: {
      id: uuidv4(),
      uploadId,
      storeId: null,
      shopDomain: 'fake.myshopify.com',
      status: 'RUNNING',
      batchJobs: {
        create: seeds.map((seed, i) => ({
          id: jobIds[i],
          storeId: 'store1',
          shopDomain: 'fake.myshopify.com',
          batchIndex: i,
          batchCount: seeds.length,
          bulkOperationId: null,
          status: 'PENDING',
          productCount: 1,
          submitAttemptedAt: seed.submitAttemptedAt ?? null,
        })),
      },
    },
  });
  return jobIds;
}

const job = async (id: string) => prisma.productImportJob.findUniqueOrThrow({ where: { id } });

runIf('resume-on-boot', () => {
  beforeEach(async () => {
    submitted.length = 0;
    attemptSeenAtSubmit.length = 0;
    taggedIds = [];
    tagListings = 0;
    storesResolve = false;
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── RELAUNCH ──────────────────────────────────────────────────────────────
  it('relaunches a job that never attempted its submit', async () => {
    const [jobId] = await seedPendingJobs();

    const summary = await resumeStore(jobStore());

    expect(summary).toMatchObject({ relaunched: 1, failed: 0 });
    const after = await job(jobId);
    expect(after.status).toBe('RUNNING');
    expect(after.bulkOperationId).toBe('gid://shopify/BulkOperation/relaunched-1');
    expect(submitted).toHaveLength(1);
  });

  // The whole scheme rests on this ordering: if the marker landed AFTER the
  // mutation, a crash in between would read as "never attempted" and relaunch
  // straight into a duplicate import.
  it('records the submit attempt BEFORE the bulk mutation is called', async () => {
    const [jobId] = await seedPendingJobs();

    await resumeStore(jobStore());

    expect(attemptSeenAtSubmit).toHaveLength(1);
    expect(attemptSeenAtSubmit[0]).toBeInstanceOf(Date);
    expect((await job(jobId)).submitAttemptedAt).toEqual(attemptSeenAtSubmit[0]);
  });

  // ── FAIL ──────────────────────────────────────────────────────────────────
  // The mutation was attempted and no op id was saved. It may be running or even
  // finished at Shopify; nothing the shop exposes says which op is ours. Relaunching
  // could duplicate the import; adopting could take a stranger's results.
  it('fails an attempted job with an actionable reason, and submits nothing', async () => {
    const [jobId] = await seedPendingJobs([{ submitAttemptedAt: new Date() }]);

    const summary = await resumeStore(jobStore());

    expect(summary).toMatchObject({ relaunched: 0, failed: 1 });
    const after = await job(jobId);
    expect(after.status).toBe('FAILED');
    expect(after.bulkOperationId).toBeNull();
    expect(after.error).toContain(SUBMIT_OUTCOME_UNKNOWN.slice(0, 60));
    expect(submitted).toEqual([]);
  });

  // ── CONCURRENT OPERATIONS ON ONE STORE ──────────────────────────────────────
  // Under the old "adopt the shop's newest op" rule, the attempted job would have
  // adopted the op the other job's relaunch had just created — two rows, one op,
  // every result attributed twice.
  it('two PENDING jobs on one store: one relaunched, one failed, never a shared op', async () => {
    const [fresh, attempted] = await seedPendingJobs([
      {},
      { submitAttemptedAt: new Date() },
    ]);

    // Resume really takes the store's (share) lock here: the attempted sibling is
    // failed for its unknown outcome, never for "store busy".
    storesResolve = true;
    const summary = await resumeStore(jobStore());

    expect(summary).toMatchObject({ relaunched: 1, failed: 1 });
    expect(submitted).toHaveLength(1);
    expect((await job(fresh)).bulkOperationId).toBe(submitted[0]);
    const failed = await job(attempted);
    expect(failed.status).toBe('FAILED');
    expect(failed.bulkOperationId).toBeNull();
    expect(failed.error).toContain(SUBMIT_OUTCOME_UNKNOWN.slice(0, 60));
  });

  // A product store's share runs as several jobs on ONE store, and they hold one
  // lock between them. Resume re-takes it as the share, so the second sibling is a
  // re-entrant acquire — not "the store is busy" with its own brother. (Under the
  // old per-job owner the second acquire met its RUNNING brother's lock and was
  // failed "store busy": relaunched 1, failed 1.)
  it('product: two never-submitted PENDING jobs on one store BOTH relaunch under the share lock', async () => {
    const jobIds = await seedPendingJobs([{}, {}]);
    const { importRunId } = await job(jobIds[0]);

    storesResolve = true;
    const summary = await resumeStore(jobStore());

    expect(summary).toMatchObject({ relaunched: 2, failed: 0 });
    expect(submitted).toHaveLength(2);
    expect((await Promise.all(jobIds.map(job))).map((j) => j.status)).toEqual(['RUNNING', 'RUNNING']);
    const lock = await prisma.storeLock.findUniqueOrThrow({ where: { storeId: 'store1' } });
    expect(lock).toMatchObject({
      ownerType: 'PRODUCT_IMPORT_STORE_SHARE',
      ownerId: shareOwner(importRunId, 'store1'),
    });
  });

  // A customer store's share runs as several jobs on ONE store, and they hold one
  // lock between them. Resume re-takes it as the share, so the second sibling is a
  // re-entrant acquire — not "the store is busy" with its own brother.
  it('customer: two never-submitted PENDING jobs on one store BOTH relaunch under the share lock', async () => {
    const validationId = uuidv4();
    await prisma.validationRun.create({
      data: {
        id: validationId,
        fileName: 'c.csv',
        fileType: 'CUSTOMER',
        totalRows: 2,
        errors: 0,
        originalRows: {
          create: [
            { id: uuidv4(), rowNumber: 2, data: { 'First Name': 'Ann', Email: 'ann@example.com' } },
            { id: uuidv4(), rowNumber: 3, data: { 'First Name': 'Bob', Email: 'bob@example.com' } },
          ],
        },
      },
    });
    const parentId = uuidv4();
    const jobIds = [uuidv4(), uuidv4()];
    await prisma.importRun.create({
      data: {
        id: parentId,
        validationId,
        storeId: null,
        shopDomain: 'fake.myshopify.com',
        status: 'RUNNING',
        batchJobs: {
          create: jobIds.map((id, i) => ({
            id,
            storeId: 'store1',
            shopDomain: 'fake.myshopify.com',
            batchIndex: i,
            batchCount: 2,
            status: 'PENDING',
            rowCount: 1,
          })),
        },
      },
    });

    storesResolve = true;
    const summary = await resumeStore(customerJobStore());

    // Under a per-job owner the second acquire met its RUNNING brother's lock and
    // was failed "store busy".
    expect(summary).toMatchObject({ relaunched: 2, failed: 0 });
    const jobs = await prisma.importBatchJob.findMany({ where: { importRunId: parentId } });
    expect(jobs.map((j) => j.status)).toEqual(['RUNNING', 'RUNNING']);
    const lock = await prisma.storeLock.findUniqueOrThrow({ where: { storeId: 'store1' } });
    expect(lock).toMatchObject({ ownerType: 'IMPORT_STORE_SHARE', ownerId: shareOwner(parentId, 'store1') });
  });

  // ── CLEANUP ───────────────────────────────────────────────────────────────
  it('cleanup: relaunches a never-attempted delete and marks intent before submitting', async () => {
    const run = await prisma.cleanupRun.create({
      data: {
        entity: 'PRODUCT',
        storeId: 'store1',
        shopDomain: 'fake.myshopify.com',
        tag: 'qa-import',
        status: 'PENDING',
        found: 1,
        submittedIds: ['gid://shopify/Product/1'],
      },
    });

    const summary = await resumeStore(cleanupStore());

    expect(summary).toMatchObject({ relaunched: 1, failed: 0 });
    expect(attemptSeenAtSubmit[0]).toBeInstanceOf(Date);
    const after = await prisma.cleanupRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ status: 'RUNNING', bulkOperationId: submitted[0] });
  });

  it('cleanup: fails an attempted delete rather than guessing its op', async () => {
    const run = await prisma.cleanupRun.create({
      data: {
        entity: 'CUSTOMER',
        storeId: 'store1',
        shopDomain: 'fake.myshopify.com',
        tag: 'qa-import',
        status: 'PENDING',
        found: 1,
        submittedIds: ['gid://shopify/Customer/1'],
        submitAttemptedAt: new Date(),
      },
    });

    const summary = await resumeStore(cleanupStore());

    expect(summary).toMatchObject({ relaunched: 0, failed: 1 });
    expect(submitted).toEqual([]);
    const after = await prisma.cleanupRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('FAILED');
    expect(after.bulkOperationId).toBeNull();
  });

  // ── "NEVER LISTED" IS NOT "LISTED, AND EMPTY" ─────────────────────────────
  // The live path writes the row, THEN lists the tagged ids, THEN saves them. A
  // crash during the listing leaves submittedIds NULL. Resume used to read that as
  // an empty list and mark the run COMPLETED with 0 deleted — while every tagged
  // record was still sitting in the store.
  const pendingCleanup = (submittedIds?: string[]) =>
    prisma.cleanupRun.create({
      data: {
        entity: 'PRODUCT',
        storeId: 'store1',
        shopDomain: 'fake.myshopify.com',
        tag: 'qa-import',
        status: 'PENDING',
        ...(submittedIds ? { found: submittedIds.length, submittedIds } : {}),
      },
    });

  it('cleanup: re-lists by tag when the ids were never listed, and deletes them', async () => {
    taggedIds = ['gid://shopify/Product/1', 'gid://shopify/Product/2'];
    const run = await pendingCleanup();
    expect(run.submittedIds).toBeNull();

    const summary = await resumeStore(cleanupStore());

    expect(summary).toMatchObject({ relaunched: 1, failed: 0 });
    expect(tagListings).toBe(1);
    const after = await prisma.cleanupRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({
      status: 'RUNNING',
      bulkOperationId: submitted[0],
      found: 2,
      submittedIds: taggedIds,
    });
  });

  it('cleanup: never-listed and genuinely nothing tagged → COMPLETED, store freed', async () => {
    taggedIds = [];
    const run = await pendingCleanup();

    await resumeStore(cleanupStore());

    expect(tagListings).toBe(1);
    const after = await prisma.cleanupRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ status: 'COMPLETED', found: 0, deleted: 0 });
    expect(submitted).toEqual([]);
    expect(await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })).toBeNull();
  });

  it('cleanup: listed-and-empty is trusted, not re-listed', async () => {
    taggedIds = ['gid://shopify/Product/9']; // would be found if it looked
    const run = await pendingCleanup([]);

    await resumeStore(cleanupStore());

    expect(tagListings).toBe(0);
    const after = await prisma.cleanupRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ status: 'COMPLETED', deleted: 0 });
  });

  // ── THE CLAIM ─────────────────────────────────────────────────────────────
  it('resolves each row exactly once, even if resume runs twice (rolling deploy)', async () => {
    const [jobId] = await seedPendingJobs();

    await resumeStore(jobStore());
    const secondPass = await resumeStore(jobStore());

    // The row is no longer PENDING, so the second boot finds nothing to do.
    expect(secondPass).toMatchObject({ relaunched: 0, failed: 0 });
    // Exactly ONE bulk op was ever submitted for this job.
    expect(submitted).toHaveLength(1);
    expect((await job(jobId)).status).toBe('RUNNING');
  });

  it('leaves terminal and RUNNING rows alone — only PENDING is resumable', async () => {
    const [jobId] = await seedPendingJobs();
    await prisma.productImportJob.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', bulkOperationId: 'gid://done' },
    });

    const summary = await resumeStore(jobStore());

    expect(summary).toMatchObject({ relaunched: 0, failed: 0, skipped: 0 });
    expect(submitted).toEqual([]);
  });
});
