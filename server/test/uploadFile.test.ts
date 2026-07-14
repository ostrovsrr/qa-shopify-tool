import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// UPLOADS ON DISK.
//
// Uploads used to live in the heap: multer.memoryStorage() plus previewStore
// holding the buffer for 30 minutes, so the memory ceiling was every CSV anyone
// had previewed recently. On a shared container that OOMs, and an OOM does not
// fail one upload — it kills the process and every colleague's in-flight import.
//
// Moving them to disk trades that for a new obligation: the files are raw merchant
// PII, and now they persist. Every one of them must be deleted. These tests are
// about that obligation, because a leak here is a privacy problem, not a perf one.
// ─────────────────────────────────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `qa-upload-test-${process.pid}`);
process.env.UPLOAD_DIR = TEST_DIR;

const { removeUploadFile, sweepOrphanUploads, UPLOAD_DIR } = await import(
  '../src/services/uploadFile'
);
const { storePreview, getPreview, deletePreview } = await import('../src/services/previewStore');
const { parseCsvFile } = await import('../src/services/csvParser.service');
const { parseProductCsvFile } = await import('../src/services/productCsvParser');

/** Write a temp upload, optionally aged so the sweep considers it orphaned. */
function writeUpload(name: string, body: string, ageMs = 0): string {
  const filePath = path.join(UPLOAD_DIR, name);
  fs.writeFileSync(filePath, body);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, when, when);
  }
  return filePath;
}

const exists = (p: string): boolean => fs.existsSync(p);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('uploads live on disk, and every one of them gets deleted', () => {
  beforeEach(() => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    for (const f of fs.readdirSync(UPLOAD_DIR)) fs.unlinkSync(path.join(UPLOAD_DIR, f));
  });
  afterAll(() => {
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  });

  it('honours UPLOAD_DIR so a container can point uploads at a scratch volume', () => {
    expect(UPLOAD_DIR).toBe(TEST_DIR);
  });

  // ── parsing straight off disk ─────────────────────────────────────────────

  it('parses a customer CSV from disk without ever holding the bytes', async () => {
    const file = writeUpload(
      'c.csv',
      'First Name,Last Name,Email\nAnn,Lee,ann@example.com\nBo,Ng,bo@example.com\n',
    );

    const { rows, headers } = await parseCsvFile(file);

    expect(headers).toEqual(['First Name', 'Last Name', 'Email']);
    expect(rows).toHaveLength(2);
    // Row numbers stay 1-based-with-header, exactly as the buffer parser produced
    // them — the reports and every bulk-result mapping key off these.
    expect(rows[0].rowNumber).toBe(2);
    expect(rows[1].original.Email).toBe('bo@example.com');
  });

  it('parses a product CSV from disk, grouped by Handle', async () => {
    const file = writeUpload(
      'p.csv',
      'Handle,Title\nalpha,Alpha\nalpha,\nbeta,Beta\n',
    );

    const { rows, groups } = await parseProductCsvFile(file);

    expect(rows).toHaveLength(3);
    // The import unit is a PRODUCT (one per Handle), not a row.
    expect(groups.map((g) => g.handle)).toEqual(['alpha', 'beta']);
  });

  it('strips the UTF-8 BOM when reading from disk (Excel and Shopify both emit one)', async () => {
    // Without bom:true the first header parses as "﻿Handle" and groupByHandle
    // finds zero products in a perfectly good file.
    const file = writeUpload('bom.csv', '﻿Handle,Title\nalpha,Alpha\n');

    const { headers, groups } = await parseProductCsvFile(file);

    expect(headers[0]).toBe('Handle');
    expect(groups).toHaveLength(1);
  });

  // ── the preview entry OWNS its file ───────────────────────────────────────

  it('deletePreview unlinks the file, not just the map entry', async () => {
    const file = writeUpload('preview.csv', 'Email\na@b.com\n');
    const uploadId = storePreview({
      fileName: 'preview.csv',
      filePath: file,
      headers: ['Email'],
      sampleRows: [],
    });

    expect(getPreview(uploadId)).toBeDefined();

    deletePreview(uploadId);
    await settle();

    // An entry dropped without its file leaves merchant PII on disk with nobody
    // left holding a reference to it. The two must never come apart.
    expect(getPreview(uploadId)).toBeUndefined();
    expect(exists(file)).toBe(false);
  });

  it('an expired preview unlinks its file when it is read', async () => {
    const file = writeUpload('stale.csv', 'Email\na@b.com\n');
    const uploadId = storePreview({
      fileName: 'stale.csv',
      filePath: file,
      headers: ['Email'],
      sampleRows: [],
    });

    // Age the entry past the 30-minute TTL.
    const entry = getPreview(uploadId)!;
    entry.createdAt = new Date(Date.now() - 31 * 60 * 1000);

    expect(getPreview(uploadId)).toBeUndefined();
    await settle();
    expect(exists(file)).toBe(false);
  });

  // ── the orphan sweep: what a crash leaves behind ──────────────────────────

  it('sweeps uploads the last process wrote but never consumed', async () => {
    // A crash between multer writing the file and the handler reading it. Nobody
    // is coming back for this, and it is raw PII.
    const orphan = writeUpload('orphan.csv', 'Email\na@b.com\n', 2 * 60 * 60 * 1000);

    const removed = await sweepOrphanUploads();

    expect(removed).toBe(1);
    expect(exists(orphan)).toBe(false);
  });

  it('does NOT sweep a file a live preview is still holding', async () => {
    // The sweep's cutoff (1h) is deliberately longer than previewStore's TTL
    // (30m), so it can never pull a file out from under a preview that is still
    // valid — which would turn "click Validate" into "upload not found".
    const fresh = writeUpload('fresh.csv', 'Email\na@b.com\n', 20 * 60 * 1000);

    const removed = await sweepOrphanUploads();

    expect(removed).toBe(0);
    expect(exists(fresh)).toBe(true);
  });

  it('sweeping an empty or missing directory is a no-op, not a crash', async () => {
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
    await expect(sweepOrphanUploads()).resolves.toBe(0);
  });

  // ── cleanup must never break a request ────────────────────────────────────

  it('removeUploadFile swallows a missing file', async () => {
    expect(() => removeUploadFile(path.join(UPLOAD_DIR, 'never-existed.csv'))).not.toThrow();
    expect(() => removeUploadFile(undefined)).not.toThrow();
    await settle();
  });
});
