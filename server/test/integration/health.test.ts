import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/index';
import prisma from '../../src/db/prisma';

// ─────────────────────────────────────────────────────────────────────────────
// The liveness probe the hosting platform will call.
//
// It must NOT touch Shopify. A health check that calls a third-party API means an
// outage at Shopify — or a single expired token — makes the platform conclude that
// OUR container is unhealthy and kill it, taking every in-flight import with it.
// The imports would survive (they are PENDING rows and resume on boot), but the
// restart loop would not stop until Shopify came back.
//
// It DOES check the database, because a server that cannot reach Postgres cannot do
// anything useful and should be restarted.
// ─────────────────────────────────────────────────────────────────────────────

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

runIf('health probe', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('reports healthy when the database is reachable', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('answers without any Shopify store configured', async () => {
    // setEnv pins the Shopify env to empty for the whole suite, so this test is
    // running in exactly the state the guard describes: no store, no token, no
    // network. A probe that needed Shopify would fail here — and in production it
    // would take the container down with it.
    expect(process.env.SHOPIFY_TEST_STORES).toBe('[]');

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });
});
