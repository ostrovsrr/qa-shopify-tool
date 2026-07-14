import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// THE STORE BUSY-LOCK.
//
// One operation per Shopify store at a time. With a shared store pool and five
// colleagues, this is the only thing keeping two of them off the same store — and
// the cleanup routes delete BY TAG ACROSS AN ENTIRE STORE, so "two of them on the
// same store" is not a slow import, it is one colleague deleting the records the
// other's import is about to reconcile against.
//
// The four properties that matter, and what breaks if each one regresses:
//
//   1. Same store, twice → refused.        Otherwise Shopify bounces the second
//                                          bulk op with a confusing error, or worse,
//                                          the two silently interleave.
//   2. Cross-entity contends.              Shopify's limit is ONE bulk mutation per
//                                          SHOP, not per shop per entity. A key of
//                                          (storeId, entity) would wave a customer
//                                          import and a product import straight into
//                                          each other. The key is bare storeId.
//   3. A batch is ALL OR NOTHING.          Fanning out to the free stores and failing
//                                          the busy one is a partial fan-out — the
//                                          exact half-done, half-reported work the
//                                          PENDING pre-persist exists to prevent.
//   4. Different stores never contend.     The lock must not serialize the parallel
//                                          batch import, which is the whole feature.
// ─────────────────────────────────────────────────────────────────────────────

const fakeClient = {
  shop: 'fake.myshopify.com',
  verifyConnection: async () => ({ ok: true, shop: 'fake.myshopify.com' }),
  query: async () => ({ locations: { nodes: [{ id: 'gid://shopify/Location/1' }] } }),
};

vi.mock('../../src/services/shopifyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyClient')>();
  return { ...actual, getShopifyClient: async () => fakeClient };
});

// The submit SUCCEEDS here — that is the point. The run reaches RUNNING and stays
// there, holding its store's lock, which is the state every assertion below probes.
vi.mock('../../src/services/shopifyBulk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shopifyBulk')>();
  return {
    ...actual,
    stagedUpload: async () => 'staged/path',
    runBulkMutation: async () => `gid://shopify/BulkOperation/${Math.random()}`,
  };
});

const prisma = (await import('../../src/db/prisma')).default;
const { resetDb } = await import('./resetDb');
const { startProductImport, startBatchProductImport } = await import(
  '../../src/services/productImport.service'
);
const { startCustomerImport } = await import('../../src/services/shopifyImport.service');
const { startCleanupRun } = await import('../../src/services/cleanupRun.service');
const { acquireStoreLock, releaseStoreLock, StoreBusyError, busyStores } = await import(
  '../../src/services/storeLock.service'
);

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

async function seedUpload(): Promise<string> {
  const uploadId = uuidv4();
  await prisma.productUploadRun.create({
    data: {
      id: uploadId,
      fileName: 'products.csv',
      productCount: 2,
      originalRows: {
        create: [
          { id: uuidv4(), rowNumber: 1, data: { Handle: 'alpha', Title: 'Alpha' } },
          { id: uuidv4(), rowNumber: 2, data: { Handle: 'beta', Title: 'Beta' } },
        ],
      },
    },
  });
  return uploadId;
}

async function seedValidation(): Promise<string> {
  const validationId = uuidv4();
  await prisma.validationRun.create({
    data: {
      id: validationId,
      fileName: 'customers.csv',
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
  return validationId;
}

runIf('store busy-lock', () => {
  beforeEach(resetDb);
  // This suite deliberately leaves LIVE locks behind (that is what it tests), so it
  // must not hand them to the next suite: a lock whose holder is still non-terminal
  // is not self-healing, and the next file's import would be refused as "store busy"
  // with no visible connection to its cause. It did exactly that once.
  afterAll(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  // ── 1. the basic exclusion ──────────────────────────────────────────────────

  it('refuses a second import into a store that is already importing', async () => {
    const first = await startProductImport(await seedUpload(), 'store1');
    expect(first).toMatchObject({ ok: true });

    const second = await startProductImport(await seedUpload(), 'store1');

    expect(second).toMatchObject({ ok: false, busy: true });
    expect((second as { error: string }).error).toContain('store1');
    expect((second as { error: string }).error).toContain('busy');
  });

  it('refuses without writing a run row — a rejected import leaves NO trace', async () => {
    await startProductImport(await seedUpload(), 'store1');

    const uploadId = await seedUpload();
    await startProductImport(uploadId, 'store1');

    // The lock is taken in the same transaction as the pre-persist, so a refusal
    // rolls the row back with it. A PENDING orphan here would be worse than the
    // collision: resume-on-boot would later find it and launch it.
    const runs = await prisma.productImportRun.findMany({ where: { uploadId } });
    expect(runs).toHaveLength(0);
  });

  // ── 2. the cross-entity case (the one a naive key gets wrong) ───────────────

  it('a CUSTOMER import contends with a PRODUCT import on the same store', async () => {
    const product = await startProductImport(await seedUpload(), 'store1');
    expect(product).toMatchObject({ ok: true });

    const customer = await startCustomerImport(await seedValidation(), 'store1');

    // Shopify allows one bulk mutation per SHOP, not one per shop per entity. If
    // the lock were keyed (storeId, entity) this would sail through and Shopify
    // would reject it with an error nobody can act on.
    expect(customer).toMatchObject({ ok: false, busy: true });
  });

  it('a cleanup is refused while an import holds the store', async () => {
    await startProductImport(await seedUpload(), 'store1');

    const cleanup = await startCleanupRun('PRODUCT', 'store1', 'qa-import');

    // The highest-blast-radius route in the app, aimed at a store that is mid-import.
    // Note Shopify's own per-shop limit does NOT cover this: the small-teardown path
    // deletes serially, not as a bulk op. This lock is the only thing in the way.
    expect(cleanup.status).toBe('FAILED');
    expect(cleanup.error).toContain('busy');
    expect(cleanup.deleted).toBe(0);
  });

  // ── 3. all-or-nothing across a batch ────────────────────────────────────────

  it('a batch overlapping ONE busy store writes nothing and locks nothing', async () => {
    await startProductImport(await seedUpload(), 'store2');

    const uploadId = await seedUpload();
    const batch = await startBatchProductImport(uploadId, ['store1', 'store2']);

    expect(batch).toMatchObject({ ok: false, busy: true });

    // Not one job, not one row, not one lock. Fanning out to store1 and failing
    // store2 would be a partial fan-out — precisely the half-done, half-reported
    // work the PENDING pre-persist exists to make impossible.
    expect(await prisma.productImportRun.findMany({ where: { uploadId } })).toHaveLength(0);
    const store1Lock = await prisma.storeLock.findUnique({ where: { storeId: 'store1' } });
    expect(store1Lock).toBeNull();
  });

  // ── 4. distinct stores stay parallel ───────────────────────────────────────

  it('does NOT serialize a batch across distinct stores', async () => {
    const uploadId = await seedUpload();
    const batch = await startBatchProductImport(uploadId, ['store1', 'store2']);

    expect(batch).toMatchObject({ ok: true });

    // Each JOB owns its own store's lock — the parent owns none, its storeId being
    // legitimately NULL. If the lock ever collapsed to one-per-batch, the parallel
    // import (the entire point of the products flow) would serialize.
    const locks = await prisma.storeLock.findMany({ orderBy: { storeId: 'asc' } });
    expect(locks.map((l) => l.storeId)).toEqual(['store1', 'store2']);
    expect(locks.every((l) => l.ownerType === 'PRODUCT_IMPORT_JOB')).toBe(true);
  });

  it('an import into a DIFFERENT store is unaffected', async () => {
    await startProductImport(await seedUpload(), 'store1');
    const other = await startProductImport(await seedUpload(), 'store2');
    expect(other).toMatchObject({ ok: true });
  });

  // ── release, and the safety net when release is missed ──────────────────────

  it('releases the store when the run fails before it ever starts', async () => {
    // seedUpload with no products → the run fails on "no products to import" and
    // must NOT strand the store for 30 minutes.
    const empty = uuidv4();
    await prisma.productUploadRun.create({
      data: { id: empty, fileName: 'empty.csv', productCount: 0 },
    });

    await startProductImport(empty, 'store1');
    expect(await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })).toBeNull();

    const next = await startProductImport(await seedUpload(), 'store1');
    expect(next).toMatchObject({ ok: true });
  });

  it('steals a lock whose owner already reached a terminal state', async () => {
    const first = await startProductImport(await seedUpload(), 'store1');
    const runId = (first as { importRunId: string }).importRunId;

    // Simulate the release being MISSED: the run finishes, but its lock row is
    // still sitting there. This is the safety net — there are a dozen terminal
    // transitions across the two flows plus cleanup, and forgetting one must not
    // wedge a store until the TTL expires. An acquirer that finds a lock held by an
    // already-terminal row simply takes it.
    await prisma.productImportRun.update({
      where: { id: runId },
      data: { status: 'COMPLETED' },
    });
    expect(await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })).not.toBeNull();

    const next = await startProductImport(await seedUpload(), 'store1');
    expect(next).toMatchObject({ ok: true });
  });

  it('steals a lock whose owner row no longer exists', async () => {
    await acquireStoreLock(prisma, 'store1', {
      ownerType: 'PRODUCT_IMPORT_RUN',
      ownerId: uuidv4(), // never existed — e.g. rolled back after the lock was taken
      operation: 'a product import',
    });

    const next = await startProductImport(await seedUpload(), 'store1');
    expect(next).toMatchObject({ ok: true });
  });

  it('steals an EXPIRED lock even though its owner is still non-terminal', async () => {
    const first = await startProductImport(await seedUpload(), 'store1');
    expect(first).toMatchObject({ ok: true });

    // The run is RUNNING and nobody is polling it — the browser watching it closed.
    // Nothing will ever advance it to terminal, so without the TTL the store would
    // be locked forever.
    await prisma.storeLock.update({
      where: { storeId: 'store1' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const next = await startProductImport(await seedUpload(), 'store1');
    expect(next).toMatchObject({ ok: true });
  });

  // ── re-entrancy: an owner may re-take its own lock ─────────────────────────

  it('lets the SAME owner re-acquire its own lock (resume must not deadlock itself)', async () => {
    const owner = {
      ownerType: 'PRODUCT_IMPORT_RUN' as const,
      ownerId: uuidv4(),
      operation: 'a product import',
    };
    await acquireStoreLock(prisma, 'store1', owner);

    // Resume-on-boot re-takes the lock for a row it may still be holding from
    // before the crash. If acquire were not re-entrant, every resumable row would
    // fail against its own lock.
    await expect(acquireStoreLock(prisma, 'store1', owner)).resolves.toBeUndefined();
  });

  it('throws StoreBusyError naming the store and what is holding it', async () => {
    await acquireStoreLock(prisma, 'store1', {
      ownerType: 'CLEANUP_RUN',
      ownerId: uuidv4(),
      operation: 'a product cleanup',
    });
    // The holder must look ALIVE for the lock to bite, so give it a real
    // non-terminal row to point at.
    const lock = await prisma.storeLock.findUnique({ where: { storeId: 'store1' } });
    await prisma.cleanupRun.create({
      data: {
        id: lock!.ownerId,
        entity: 'PRODUCT',
        shopDomain: 'fake.myshopify.com',
        tag: 'qa-import',
        status: 'RUNNING',
      },
    });

    await expect(
      acquireStoreLock(prisma, 'store1', {
        ownerType: 'PRODUCT_IMPORT_RUN',
        ownerId: uuidv4(),
        operation: 'a product import',
      }),
    ).rejects.toThrow(StoreBusyError);

    // And it is visible to the store picker, so the UI can grey the store out
    // BEFORE a colleague commits to a run.
    const busy = await busyStores();
    expect(busy.map((b) => b.storeId)).toEqual(['store1']);
    expect(busy[0].operation).toBe('a product cleanup');
  });

  it('releaseStoreLock only releases locks this owner still holds', async () => {
    const loser = uuidv4();
    await acquireStoreLock(prisma, 'store1', {
      ownerType: 'PRODUCT_IMPORT_RUN',
      ownerId: loser,
      operation: 'a product import',
    });
    // Someone else takes the store over (the previous owner's lock had expired).
    const winner = uuidv4();
    await prisma.storeLock.update({
      where: { storeId: 'store1' },
      data: { ownerId: winner },
    });

    // The old owner finally finishes and releases. It must NOT rip the store out
    // from under the new holder.
    await releaseStoreLock(loser);

    const lock = await prisma.storeLock.findUnique({ where: { storeId: 'store1' } });
    expect(lock?.ownerId).toBe(winner);
  });
});
