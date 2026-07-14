import fs from 'fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/index';
import prisma from '../../src/db/prisma';
import { UPLOAD_DIR } from '../../src/services/uploadFile';
import { resetDb } from './resetDb';

// ─────────────────────────────────────────────────────────────────────────────
// NO MERCHANT CSV IS LEFT ON DISK.
//
// Uploads used to sit in the heap; now they stream to a temp file. That fixes the
// OOM that could kill every colleague's in-flight import — but it hands us a new
// obligation, and it is a privacy one rather than a performance one: the file is
// raw merchant PII, it now persists, and it is only gone if somebody deletes it.
//
// So these tests drive the REAL HTTP routes end to end and then look at the
// directory. The unit tests prove each deletion path in isolation; this proves the
// paths are actually wired to the routes a colleague uses.
//
// The one file that is deliberately KEPT is the preview: /validate re-reads it in a
// later request, so it has to outlive the one that created it. It is deleted the
// moment validate consumes it.
// ─────────────────────────────────────────────────────────────────────────────

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const CSV = [
  'First Name,Last Name,Email,Phone',
  'John,Doe,john@example.com,4165551234',
  'Amy,Lee,not-an-email,',
].join('\n');

const PRODUCT_CSV = ['Handle,Title', 'alpha,Alpha', 'beta,Beta'].join('\n');

/** Temp uploads currently on disk. */
function uploadsOnDisk(): string[] {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR);
}

/** unlink is fire-and-forget so the response does not wait on the filesystem. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

runIf('uploads are deleted from disk', () => {
  beforeEach(async () => {
    await resetDb();
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    for (const f of uploadsOnDisk()) fs.rmSync(`${UPLOAD_DIR}/${f}`, { force: true });
  });
  afterAll(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it('preview KEEPS the file (validate needs it), then validate deletes it', async () => {
    const preview = await request(app)
      .post('/api/customer-validation/preview')
      .attach('file', Buffer.from(CSV), { filename: 'customers.csv', contentType: 'text/csv' });
    expect(preview.status).toBe(200);

    // Still here on purpose: /validate arrives in a LATER request and re-reads it.
    // If this were deleted, clicking Validate would say "upload not found".
    await settle();
    expect(uploadsOnDisk()).toHaveLength(1);

    const validate = await request(app).post('/api/customer-validation/validate').send({
      uploadId: preview.body.uploadId,
      columnMapping: preview.body.suggestedMapping,
    });
    expect(validate.status).toBe(200);

    // Consumed → gone. Not held until the 30-minute TTL, which is what the old
    // in-memory buffer did.
    await settle();
    expect(uploadsOnDisk()).toHaveLength(0);
  });

  it('the one-shot customer upload route deletes its file', async () => {
    const res = await request(app)
      .post('/api/customer-validation/upload')
      .attach('file', Buffer.from(CSV), { filename: 'customers.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    await settle();
    expect(uploadsOnDisk()).toHaveLength(0);
  });

  it('the product upload route deletes its file (the rows are in Postgres now)', async () => {
    const res = await request(app)
      .post('/api/product-upload')
      .attach('file', Buffer.from(PRODUCT_CSV), {
        filename: 'products.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(201);
    expect(res.body.productCount).toBe(2);
    await settle();
    expect(uploadsOnDisk()).toHaveLength(0);
  });

  it('deletes the file even when parsing blows up mid-request', async () => {
    // A CSV so malformed the parser throws. The request fails — the file must
    // STILL be gone. A failure path that leaks PII is the easiest one to miss,
    // because nobody looks at the disk after an error.
    const res = await request(app)
      .post('/api/product-upload')
      .attach('file', Buffer.from('Handle,Title\n"unterminated,quote\n'), {
        filename: 'broken.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    await settle();
    expect(uploadsOnDisk()).toHaveLength(0);
  });
});
