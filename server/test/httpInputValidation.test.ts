import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app, { SPA_FALLBACK_ROUTE } from '../src/index';
import prisma from '../src/db/prisma';

describe('HTTP input and readiness errors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a non-CSV upload as a 400, not an internal server failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(app)
      .post('/api/product-upload')
      .attach('file', Buffer.from('not,csv'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only csv files/i);
    expect(res.body.requestId).toBeDefined();
  });

  it('rejects a customer CSV that has headers but no data rows', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(app)
      .post('/api/customer-validation/preview')
      .attach('file', Buffer.from('Email,Phone\n'), {
        filename: 'empty.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no customer data rows/i);
  });

  it('rejects a product CSV with no Handle column before writing a run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(app)
      .post('/api/product-upload')
      .attach('file', Buffer.from('Title\nWidget\n'), {
        filename: 'products.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must contain a "Handle" column/i);
  });

  it('does not expose a database connection error through the health endpoint', async () => {
    const leaky = 'postgresql://user:secret@db.internal/prod';
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error(leaky));

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Database unavailable.');
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(res.body.requestId).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client mistakes keep their own status. express.json() rejects a malformed or
// oversized body with an http-errors error (status 400/413, expose:true); the
// handler used to turn those into a 500 "something went wrong on our end".
// And an unknown /api endpoint is a JSON 404, not Express's HTML "Cannot GET".
// ─────────────────────────────────────────────────────────────────────────────
describe('client errors and unknown endpoints', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers malformed JSON with a 400, not a 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(app)
      .post('/api/customer-validation/validate')
      .set('Content-Type', 'application/json')
      .send('{"previewId": ');

    expect(res.status).toBe(400);
    expect(res.body.error).not.toMatch(/went wrong on our end/i);
    expect(res.body.requestId).toBeDefined();
  });

  it('answers an oversized JSON body with a 413', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(app)
      .post('/api/customer-validation/validate')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.requestId).toBeDefined();
  });

  it.each(['/api/no-such-endpoint', '/api', '/api/shopify/no/such/route'])(
    'answers an unknown API path (%s) with a JSON 404',
    async (url) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await request(app).get(url);

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.error).toMatch(/no such api endpoint/i);
      expect(res.body.requestId).toBeDefined();
    },
  );
});

describe('SPA fallback route', () => {
  it('never serves index.html for /api or anything under it', () => {
    expect(SPA_FALLBACK_ROUTE.test('/api')).toBe(false);
    expect(SPA_FALLBACK_ROUTE.test('/api/')).toBe(false);
    expect(SPA_FALLBACK_ROUTE.test('/api/typo')).toBe(false);
  });

  it('still serves the client routes, including paths that merely start with "api"', () => {
    expect(SPA_FALLBACK_ROUTE.test('/')).toBe(true);
    expect(SPA_FALLBACK_ROUTE.test('/customers')).toBe(true);
    expect(SPA_FALLBACK_ROUTE.test('/products/123')).toBe(true);
    expect(SPA_FALLBACK_ROUTE.test('/apidocs')).toBe(true);
  });
});
