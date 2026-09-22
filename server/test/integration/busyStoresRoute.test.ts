import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../src/index';
import prisma from '../../src/db/prisma';
import { acquireStoreLock } from '../../src/services/storeLock.service';
import { resetDb } from './resetDb';

// GET /api/shopify/stores/busy feeds the "In use" line on both store pickers
// (TODOS §1 follow-up). A lock only counts while its owner is still running: a
// finished owner must not leave a store looking busy.
const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

runIf('GET /api/shopify/stores/busy', () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it('is an empty list when nothing is running', async () => {
    const res = await request(app).get('/api/shopify/stores/busy');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ busy: [] });
  });

  it('lists a store held by a running cleanup, and drops it once that cleanup finishes', async () => {
    const ownerId = uuidv4();
    await prisma.cleanupRun.create({
      data: { id: ownerId, entity: 'PRODUCT', shopDomain: 'fake.myshopify.com', tag: 'qa-import', status: 'RUNNING' },
    });
    await acquireStoreLock(prisma, 'store2', { ownerType: 'CLEANUP_RUN', ownerId, operation: 'a product cleanup' });

    const busy = await request(app).get('/api/shopify/stores/busy');
    expect(busy.body.busy).toMatchObject([{ storeId: 'store2', operation: 'a product cleanup' }]);

    await prisma.cleanupRun.update({ where: { id: ownerId }, data: { status: 'COMPLETED' } });
    const free = await request(app).get('/api/shopify/stores/busy');
    expect(free.body).toEqual({ busy: [] });
  });
});
