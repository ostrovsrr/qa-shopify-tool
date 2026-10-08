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
//   1. Same store, twice → refused.        Otherwise, from API 2026-01, Shopify
//                                          accepts the second bulk op (up to five
//                                          per shop) and the two silently interleave.
//   2. Cross-entity contends.              Shopify's per-shop limit spans entities
//                                          and no longer keeps them apart. A key of
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
const { startCustomerImport, startBatchImport } = await import(
  '../../src/services/shopifyImport.service'
);
const { startCleanupRun } = await import('../../src/services/cleanupRun.service');
const {
  acquireStoreLock,
  releaseStoreLock,
  releaseShareIfDone,
  shareOwner,
  parseShareOwner,
  StoreBusyError,
  busyStores,
  liveStoreLocks,
} = await import('../../src/services/storeLock.service');
type StoreLockOwner = import('../../src/services/storeLock.service').StoreLockOwner;

// acquire must run inside a transaction: its advisory lock is transaction-scoped.
const lockStore = (storeId: string, owner: StoreLockOwner) =>
  prisma.$transaction((tx) => acquireStoreLock(tx, storeId, owner));

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

    // From API 2026-01 Shopify accepts up to five bulk mutations per shop, across
    // entities. If the lock were keyed (storeId, entity) this would sail through
    // and the two imports would silently interleave on one store.
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

  // A repeated store id used to plan two jobs on ONE shop under ONE lock (the lock
  // step dedupes, the plan did not). From API 2026-01 Shopify runs both bulk ops at
  // once, so that was two half-imports interleaving on the same store.
  it('a batch naming the same store twice plans ONE job for it (products)', async () => {
    const uploadId = await seedUpload();
    const batch = await startBatchProductImport(uploadId, ['store1', 'store1']);
    expect(batch).toMatchObject({ ok: true });

    const parent = await prisma.productImportRun.findUniqueOrThrow({
      where: { id: (batch as { importRunId: string }).importRunId },
      include: { batchJobs: true },
    });
    expect(parent.batchJobs).toHaveLength(1);
    expect(parent.batchJobs[0]).toMatchObject({ storeId: 'store1', batchCount: 1, productCount: 2 });
  });

  // Customers split one store's share across several ops on purpose — but as ONE
  // share of ONE store, sized for a single store, never as two shares of it.
  it('a batch naming the same store twice plans ONE share for it (customers)', async () => {
    const validationId = await seedValidation();
    const batch = await startBatchImport(validationId, ['store1', 'store1']);
    expect(batch).toMatchObject({ ok: true });

    const parent = await prisma.importRun.findUniqueOrThrow({
      where: { id: (batch as { importRunId: string }).importRunId },
      include: { batchJobs: true },
    });
    // One row → one op; a doubled store id must not make that two.
    expect(parent.batchJobs).toHaveLength(1);
    expect(parent.batchJobs[0]).toMatchObject({ storeId: 'store1', batchCount: 1 });
    const locks = await prisma.storeLock.findMany();
    expect(locks).toHaveLength(1);
    expect(locks[0].ownerType).toBe('IMPORT_STORE_SHARE');
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
    await lockStore('store1', {
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
    await lockStore('store1', owner);

    // Resume-on-boot re-takes the lock for a row it may still be holding from
    // before the crash. If acquire were not re-entrant, every resumable row would
    // fail against its own lock.
    await expect(lockStore('store1', owner)).resolves.toBeUndefined();
  });

  it('throws StoreBusyError naming the store and what is holding it', async () => {
    await lockStore('store1', {
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
      lockStore('store1', {
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
    await lockStore('store1', {
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

  // ── acquire only means something inside a transaction ────────────────────
  // pg_advisory_xact_lock is released when its transaction ends. On the bare
  // client every statement is its own transaction, so the advisory lock was gone
  // before the check-then-upsert it was meant to guard even started.
  it('refuses to acquire on the bare client, where the advisory lock guards nothing', async () => {
    await expect(
      acquireStoreLock(prisma, 'store1', {
        ownerType: 'CLEANUP_RUN',
        ownerId: uuidv4(),
        operation: 'a product cleanup',
      }),
    ).rejects.toThrow(/inside prisma\.\$transaction/);
    expect(await prisma.storeLock.count()).toBe(0);
  });

  // ── a FAILED-while-submitting holder may still be running at Shopify ──────
  async function cleanupHolder(data: { status: string; submitAttemptedAt?: Date }) {
    const id = uuidv4();
    await prisma.cleanupRun.create({
      data: {
        id,
        entity: 'PRODUCT',
        storeId: 'store1',
        shopDomain: 'fake.myshopify.com',
        tag: 'qa-import',
        ...data,
      },
    });
    await lockStore('store1', { ownerType: 'CLEANUP_RUN', ownerId: id, operation: 'a product cleanup' });
    return id;
  }
  const anImport = () => ({
    ownerType: 'PRODUCT_IMPORT_RUN' as const,
    ownerId: uuidv4(),
    operation: 'a product import',
  });

  it('honours the lock of a holder that FAILED mid-submit, until its TTL', async () => {
    await cleanupHolder({ status: 'FAILED', submitAttemptedAt: new Date() });

    // Its row is terminal, but the bulk mutation may have reached Shopify and be
    // deleting right now. Stealing the store here is landing on a live delete.
    await expect(lockStore('store1', anImport())).rejects.toThrow(/may still be busy/);
    expect((await busyStores()).map((b) => b.storeId)).toEqual(['store1']);

    // The TTL still bounds it.
    await prisma.storeLock.update({
      where: { storeId: 'store1' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(lockStore('store1', anImport())).resolves.toBeUndefined();
  });

  it('still steals the lock of a holder that failed BEFORE submitting', async () => {
    // No submitAttemptedAt: provably nothing reached Shopify.
    await cleanupHolder({ status: 'FAILED' });
    await expect(lockStore('store1', anImport())).resolves.toBeUndefined();
  });

  // ── a store's SHARE of a batch run: several sibling jobs, ONE lock ────────
  // Up to five jobs of one batch run on the same store at once. If the first to
  // finish released the store, its siblings would still be running on an "idle" store.
  async function seedShare(
    flow: 'customer' | 'product',
    jobs: { status: string; submitAttemptedAt?: Date; bulkOperationId?: string }[],
  ) {
    const parentId = uuidv4();
    const base = { storeId: 'store1', shopDomain: 'fake.myshopify.com', batchCount: jobs.length };
    if (flow === 'customer') {
      const validationId = await seedValidation();
      await prisma.importRun.create({
        data: { id: parentId, validationId, shopDomain: 'fake.myshopify.com', status: 'RUNNING' },
      });
      for (const [i, j] of jobs.entries()) {
        await prisma.importBatchJob.create({
          data: { id: uuidv4(), importRunId: parentId, batchIndex: i, ...base, ...j },
        });
      }
    } else {
      const uploadId = await seedUpload();
      await prisma.productImportRun.create({
        data: { id: parentId, uploadId, shopDomain: 'fake.myshopify.com', status: 'RUNNING' },
      });
      for (const [i, j] of jobs.entries()) {
        await prisma.productImportJob.create({
          data: { id: uuidv4(), importRunId: parentId, batchIndex: i, ...base, ...j },
        });
      }
    }
    const ownerType =
      flow === 'customer' ? ('IMPORT_STORE_SHARE' as const) : ('PRODUCT_IMPORT_STORE_SHARE' as const);
    await lockStore('store1', {
      ownerType,
      ownerId: shareOwner(parentId, 'store1'),
      operation: 'an import',
    });
    return parentId;
  }

  describe.each(['customer', 'product'] as const)('store share (%s)', (flow) => {
    const lockHeld = async () => (await prisma.storeLock.findUnique({ where: { storeId: 'store1' } })) !== null;
    const jobsOf = (parentId: string) =>
      flow === 'customer'
        ? prisma.importBatchJob.findMany({ where: { importRunId: parentId }, orderBy: { batchIndex: 'asc' } })
        : prisma.productImportJob.findMany({ where: { importRunId: parentId }, orderBy: { batchIndex: 'asc' } });
    const setStatus = (id: string, status: string) =>
      flow === 'customer'
        ? prisma.importBatchJob.update({ where: { id }, data: { status } })
        : prisma.productImportJob.update({ where: { id }, data: { status } });

    it('is live while ANY sibling job is non-terminal', async () => {
      await seedShare(flow, [{ status: 'COMPLETED' }, { status: 'RUNNING' }, { status: 'PENDING' }]);
      expect((await busyStores()).map((b) => b.storeId)).toEqual(['store1']);
      await expect(lockStore('store1', anImport())).rejects.toThrow(StoreBusyError);
    });

    it('is outcome-unknown when a sibling FAILED mid-submit and the rest are terminal', async () => {
      await seedShare(flow, [
        { status: 'COMPLETED', bulkOperationId: 'gid://x/1' },
        { status: 'FAILED', submitAttemptedAt: new Date() },
      ]);
      await expect(lockStore('store1', anImport())).rejects.toThrow(/may still be busy/);
    });

    it('is finished (stealable) when every job is terminal and none is ambiguous', async () => {
      await seedShare(flow, [{ status: 'COMPLETED' }, { status: 'FAILED' }]);
      expect(await busyStores()).toEqual([]);
      await expect(lockStore('store1', anImport())).resolves.toBeUndefined();
    });

    it('releaseShareIfDone refuses while a sibling runs, then releases after the last', async () => {
      const parentId = await seedShare(flow, [{ status: 'RUNNING' }, { status: 'RUNNING' }]);
      const [a, b] = await jobsOf(parentId);

      await setStatus(a.id, 'COMPLETED');
      expect(await releaseShareIfDone(flow, parentId, 'store1')).toBe(false);
      expect(await lockHeld()).toBe(true);

      await setStatus(b.id, 'COMPLETED');
      expect(await releaseShareIfDone(flow, parentId, 'store1')).toBe(true);
      expect(await lockHeld()).toBe(false);
    });

    it('releaseShareIfDone refuses with an outcome-unknown sibling', async () => {
      const parentId = await seedShare(flow, [
        { status: 'COMPLETED' },
        { status: 'FAILED', submitAttemptedAt: new Date() },
      ]);
      expect(await releaseShareIfDone(flow, parentId, 'store1')).toBe(false);
      expect(await lockHeld()).toBe(true);
    });
  });

  it('a share with no jobs is judged finished', async () => {
    await lockStore('store1', {
      ownerType: 'IMPORT_STORE_SHARE',
      ownerId: shareOwner(uuidv4(), 'store1'),
      operation: 'an import',
    });
    expect(await busyStores()).toEqual([]);
  });

  it('parseShareOwner round-trips, even for a store id containing a colon', () => {
    const run = uuidv4();
    expect(parseShareOwner(shareOwner(run, 'a:b'))).toEqual({ parentRunId: run, storeId: 'a:b' });
  });

  // ── liveStoreLocks: one query per owner table, not one per lock ───────────
  it('liveStoreLocks judges many locks with one lookup per owner table', async () => {
    const live: string[] = [];
    for (const [storeId, status] of [
      ['store1', 'RUNNING'],
      ['store2', 'COMPLETED'],
      ['store3', 'RUNNING'],
      ['store4', 'PENDING'],
    ] as const) {
      const id = uuidv4();
      await prisma.cleanupRun.create({
        data: { id, entity: 'CUSTOMER', storeId, shopDomain: 'x', tag: 'qa-import', status },
      });
      await lockStore(storeId, { ownerType: 'CLEANUP_RUN', ownerId: id, operation: 'a cleanup' });
      if (status !== 'COMPLETED') live.push(storeId);
    }
    // One lock whose owner row does not exist at all.
    await lockStore('store5', anImport());

    const findMany = vi.spyOn(prisma.cleanupRun, 'findMany');
    const findUnique = vi.spyOn(prisma.cleanupRun, 'findUnique');
    try {
      const locks = await liveStoreLocks();
      expect(locks.map((l) => l.storeId).sort()).toEqual(live);
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findUnique).not.toHaveBeenCalled();
    } finally {
      findMany.mockRestore();
      findUnique.mockRestore();
    }
  });
});
