import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../src/index';
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
