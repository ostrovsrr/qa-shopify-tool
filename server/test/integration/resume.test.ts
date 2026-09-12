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

const fakeClient = {
  shop: 'fake.myshopify.com',
  verifyConnection: async () => ({ ok: true, shop: 'fake.myshopify.com' }),
  query: async () => ({ locations: { nodes: [{ id: 'gid://shopify/Location/1' }] } }),
};

vi.mock('../../src/services/shopifyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyClient')>();
  return { ...actual, getShopifyClient: async () => fakeClient };
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

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const jobStore = () => productResumableStores().find((s) => s.label === 'product-job')!;
const cleanupStore = () => cleanupResumableStores()[0];

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

    const summary = await resumeStore(jobStore());

    expect(summary).toMatchObject({ relaunched: 1, failed: 1 });
    expect(submitted).toHaveLength(1);
    expect((await job(fresh)).bulkOperationId).toBe(submitted[0]);
    const failed = await job(attempted);
    expect(failed.status).toBe('FAILED');
    expect(failed.bulkOperationId).toBeNull();
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
