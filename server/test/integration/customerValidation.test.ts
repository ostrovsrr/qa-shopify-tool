import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/index';
import prisma from '../../src/db/prisma';
import { resetDb } from './resetDb';

// These tests need a real PostgreSQL. They only run when TEST_DATABASE_URL is
// set (see setEnv.ts); otherwise they skip so `npm run test:integration`
// never wipes a developer's real database by accident.
const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// A tiny CSV whose headers are already Shopify columns, with a known set of
// issues: one invalid email and one duplicated email (two rows) => 3 errors.
const CSV = [
  'First Name,Last Name,Email,Phone',
  'John,Doe,john@example.com,4165551234',
  'Amy,Lee,not-an-email,',
  'Bob,Ray,dupe@x.com,',
  'Bo,Ray,DUPE@x.com,',
].join('\n');

const IDENTITY_MAPPING = {
  'First Name': 'First Name',
  'Last Name': 'Last Name',
  Email: 'Email',
  Phone: 'Phone',
};

const truncateAll = resetDb;

runIf('customer-validation API (integration)', () => {
  beforeEach(truncateAll);
  afterAll(async () => {
    await truncateAll();
    await prisma.$disconnect();
  });

  it('previews an uploaded CSV and suggests an identity column mapping', async () => {
    const res = await request(app)
      .post('/api/customer-validation/preview')
      .attach('file', Buffer.from(CSV), { filename: 'customers.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    expect(res.body.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.headers).toEqual(['First Name', 'Last Name', 'Email', 'Phone']);
    expect(res.body.suggestedMapping).toMatchObject(IDENTITY_MAPPING);
    expect(res.body.sampleRows.length).toBeGreaterThan(0);
  });

  it('runs the full preview → validate → persist → fetch → report flow', async () => {
    // 1. preview
    const preview = await request(app)
      .post('/api/customer-validation/preview')
      .attach('file', Buffer.from(CSV), { filename: 'customers.csv', contentType: 'text/csv' });
    const uploadId = preview.body.uploadId;

    // 2. validate with the suggested mapping
    const validate = await request(app)
      .post('/api/customer-validation/validate')
      .send({ uploadId, columnMapping: preview.body.suggestedMapping, heliosMigratedTag: false });

    expect(validate.status).toBe(200);
    expect(validate.body.totalRows).toBe(4);
    expect(validate.body.errors).toBe(3); // 1 invalid email + 2 duplicate-email rows
    expect(validate.body.warnings).toBe(0);
    expect(validate.body.issues).toHaveLength(3);
    const validationId = validate.body.validationId;

    // 3. it was persisted and is fetchable with the same counts
    const fetched = await request(app).get(`/api/customer-validation/${validationId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.errors).toBe(3);
    expect(fetched.body.issues).toHaveLength(3);

    // 4. it shows up in history
    const history = await request(app).get('/api/customer-validation/history');
    expect(history.status).toBe(200);
    expect(history.body.some((r: { id: string }) => r.id === validationId)).toBe(true);

    // 5. the Excel report downloads as a real xlsx (zip magic bytes "PK")
    const report = await request(app)
      .get(`/api/customer-validation/report/${validationId}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toContain('spreadsheetml');
    expect((report.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });

  it('updates metadata and deletes a run', async () => {
    const preview = await request(app)
      .post('/api/customer-validation/preview')
      .attach('file', Buffer.from(CSV), { filename: 'customers.csv', contentType: 'text/csv' });
    const validate = await request(app)
      .post('/api/customer-validation/validate')
      .send({ uploadId: preview.body.uploadId, columnMapping: preview.body.suggestedMapping });
    const validationId = validate.body.validationId;

    const patched = await request(app)
      .patch(`/api/customer-validation/${validationId}/metadata`)
      .send({ ticketNumber: 'QA-42', comments: 'looks good' });
    expect(patched.status).toBe(200);
    expect(patched.body.ticketNumber).toBe('QA-42');

    const deleted = await request(app).delete(`/api/customer-validation/${validationId}`);
    expect(deleted.status).toBe(200);

    const gone = await request(app).get(`/api/customer-validation/${validationId}`);
    expect(gone.status).toBe(404);
  });

  describe('input validation', () => {
    it('rejects a preview with no file (400)', async () => {
      const res = await request(app).post('/api/customer-validation/preview');
      expect(res.status).toBe(400);
    });

    it('rejects a malformed validation id (400)', async () => {
      const res = await request(app).get('/api/customer-validation/not-a-uuid');
      expect(res.status).toBe(400);
    });

    it('returns 404 validating a well-formed but unknown upload id', async () => {
      const res = await request(app)
        .post('/api/customer-validation/validate')
        .send({ uploadId: '11111111-1111-1111-1111-111111111111', columnMapping: {} });
      expect(res.status).toBe(404);
    });
  });
});
