import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/index';
import prisma from '../../src/db/prisma';
import { resetDb } from './resetDb';

// ─────────────────────────────────────────────────────────────────────────────
// THE 500 THAT USED TO LEAK.
//
// The error handler ended with `res.status(500).json({ error: err.message })`,
// which hands an unexpected error's message straight to the browser. That message
// is written for whoever reads the LOGS, and in this app it can carry the
// DATABASE_URL — password and all — plus absolute file paths, SQL, and Shopify
// tokens. Locally that is a debugging convenience: the only person reading it wrote
// it. Hosted, it is a credential leak that any unhandled bug can trigger.
//
// But a bare generic 500 makes the tool undebuggable — a colleague says "it broke"
// and nothing connects that to a line in the log. So: generic message to the user,
// correlation id to both, full stack to the log only.
//
// The distinction that matters, and the one worth testing: a failure that is about
// the USER'S INPUT still says what is wrong with it. "Something went wrong" when the
// truth is "line 2 of your CSV has an unterminated quote" turns a 10-second fix into
// a support thread.
// ─────────────────────────────────────────────────────────────────────────────

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// The kind of message an unexpected error really carries in this app.
const LEAKY = 'connect ECONNREFUSED: postgresql://postgres:hunter2@10.0.0.4:5432/prod';

runIf('error handler', () => {
  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();
    // The handler logs the real error; keep the suite output readable.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.$disconnect();
  });

  // ── the leak ──────────────────────────────────────────────────────────────

  it('never shows an unexpected error message to the user', async () => {
    // Blow up deep inside a route with an error whose message contains a password.
    const uploadService = await import('../../src/services/productUpload.service');
    vi.spyOn(uploadService, 'createProductUpload').mockRejectedValue(new Error(LEAKY));

    const res = await request(app)
      .post('/api/product-upload')
      .attach('file', Buffer.from('Handle,Title\nalpha,Alpha\n'), {
        filename: 'p.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(500);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('postgresql://');
    expect(body).not.toContain('ECONNREFUSED');

    // What the user DOES get: a sentence and something to quote.
    expect(res.body.error).toMatch(/something went wrong/i);
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.error).toContain(res.body.requestId.slice(0, 8));
  });

  // ── the correlation id ────────────────────────────────────────────────────

  it('returns a correlation id on every response, not just failures', async () => {
    const res = await request(app).get('/api/customer-validation/history');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours an upstream request id so a trace survives the proxy hop', async () => {
    // A tunnel or load balancer may already have tagged the request. Minting a
    // second id would sever the trace exactly where it gets hard to follow.
    const res = await request(app)
      .get('/api/customer-validation/history')
      .set('X-Request-Id', 'upstream-abc-123');

    expect(res.headers['x-request-id']).toBe('upstream-abc-123');
  });

  // ── failures that ARE the user's to fix still say so ──────────────────────

  it('tells the user exactly what is wrong with a malformed CSV', async () => {
    const res = await request(app)
      .post('/api/product-upload')
      .attach('file', Buffer.from('Handle,Title\n"unterminated,quote\n'), {
        filename: 'broken.csv',
        contentType: 'text/csv',
      });

    // 400, not 500: their file, their fix. And the parser's complaint is about the
    // FILE, so it reveals nothing about the server and is worth passing on.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/could not read that csv/i);
    expect(res.body.error).toMatch(/quote/i);
    expect(res.body.requestId).toBeDefined();
  });

  it('still says the file is too large rather than hiding it behind a 500', async () => {
    const res = await request(app)
      .post('/api/product-upload')
      .attach('file', Buffer.alloc(101 * 1024 * 1024), {
        filename: 'huge.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });
});
