import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/index';
import prisma from '../../src/db/prisma';
import { resetDb } from './resetDb';

// ─────────────────────────────────────────────────────────────────────────────
// ATTRIBUTION IS NOT AUTHORIZATION.
//
// Runs say who uploaded them, and the six destructive routes are logged with a
// name, because "where did my QA products go?" should have an answer. The tool is a
// deliberately SHARED workspace (decision 7a56f7f2): everybody sees every run.
//
// The dangerous thing about adding a `createdBy` column is that it is one WHERE
// clause away from being an access-control system — and it would be a terrible one,
// because the value is supplied by the client and anyone can send any name. An
// authorization check built on a value the caller controls is worse than none,
// because it also LOOKS like security.
//
// So the last test here is the important one: it asserts the workspace is still
// shared. If someone ever "helpfully" filters history by createdBy, it goes red and
// they have to come and argue for it.
// ─────────────────────────────────────────────────────────────────────────────

const runIf = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const CSV = ['Handle,Title', 'alpha,Alpha'].join('\n');

const upload = (actor?: string) => {
  const req = request(app).post('/api/product-upload');
  if (actor) req.set('X-QA-User', actor);
  return req.attach('file', Buffer.from(CSV), {
    filename: 'p.csv',
    contentType: 'text/csv',
  });
};

runIf('attribution and the destructive-action log', () => {
  beforeEach(async () => {
    await resetDb();
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "action_log" RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('records who uploaded a run', async () => {
    const res = await upload('rodion');
    expect(res.status).toBe(201);

    const run = await prisma.productUploadRun.findUniqueOrThrow({
      where: { id: res.body.uploadId },
    });
    expect(run.createdBy).toBe('rodion');
  });

  it('normalizes the actor to an opaque slug — not an email', async () => {
    // The name lands in a shared history and in server logs. There is no reason for
    // it to carry an identifier more personal than the tool actually needs.
    const res = await upload('Josh.Smith@Example.COM');

    const run = await prisma.productUploadRun.findUniqueOrThrow({
      where: { id: res.body.uploadId },
    });
    expect(run.createdBy).toBe('josh.smithexample.com'); // '@' stripped
    expect(run.createdBy).not.toContain('@');
  });

  it('falls back to "unknown" rather than failing when nobody said who they are', async () => {
    const res = await upload();

    const run = await prisma.productUploadRun.findUniqueOrThrow({
      where: { id: res.body.uploadId },
    });
    expect(run.createdBy).toBe('unknown');
  });

  // ── the log ───────────────────────────────────────────────────────────────

  it('logs a destructive delete with who did it and what they hit', async () => {
    const created = await upload('rodion');
    const uploadId = created.body.uploadId;

    await request(app)
      .delete(`/api/product-upload/${uploadId}`)
      .set('X-QA-User', 'josh')
      .expect(200);

    const log = await prisma.actionLog.findMany();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      actor: 'josh',
      action: 'DELETE_PRODUCT_UPLOAD',
      target: uploadId,
    });

    // And it is readable — that is the entire point of writing it.
    const res = await request(app).get('/api/action-log').expect(200);
    expect(res.body[0].actor).toBe('josh');
  });

  it('a failure to write the audit log does not fail the action', async () => {
    // The log is for forensics. Refusing a delete because the audit insert hiccuped
    // would be a worse outcome than a missing line.
    const created = await upload('rodion');
    await prisma.$executeRawUnsafe('DROP TABLE "action_log"');

    try {
      await request(app)
        .delete(`/api/product-upload/${created.body.uploadId}`)
        .expect(200);
    } finally {
      // Put it back for the next test.
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "action_log" (
          "id" TEXT NOT NULL,
          "actor" TEXT NOT NULL,
          "action" TEXT NOT NULL,
          "target" TEXT NOT NULL,
          "storeId" TEXT,
          "detail" JSONB,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "action_log_pkey" PRIMARY KEY ("id")
        )`);
    }
  });

  // ── THE ONE THAT MATTERS ──────────────────────────────────────────────────

  it('does NOT gate anything on createdBy — the workspace stays shared', async () => {
    await upload('rodion');
    await upload('josh');

    // Josh asks for the history and sees Rodion's run too. If this ever returns one
    // row, someone has quietly turned attribution into authorization — using a value
    // the client supplies, which anyone can forge. That is not a smaller feature than
    // real auth; it is a false impression of it.
    const res = await request(app)
      .get('/api/product-upload/history')
      .set('X-QA-User', 'josh')
      .expect(200);

    expect(res.body).toHaveLength(2);
    expect(res.body.map((r: { createdBy: string }) => r.createdBy).sort()).toEqual([
      'josh',
      'rodion',
    ]);
  });
});
