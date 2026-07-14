import fs from 'fs';
import os from 'os';
import path from 'path';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// UPLOADS GO TO DISK, NOT TO RAM.
//
// multer.memoryStorage() held the entire uploaded CSV in the heap — up to 100 MB
// per request, by the configured limit. Locally, with one user and one upload at a
// time, that is invisible. Hosted, on a 512 MB container shared by five colleagues,
// it is the whole ballgame: two people uploading at once is 200 MB of raw buffers
// before a single row has been parsed, and an OOM does not politely fail that one
// request — it kills the process, and with it EVERY import that was in flight for
// everyone else. The pre-persist work means those imports are now recoverable, but
// "recoverable" is a poor substitute for "not killed".
//
// It was worse than one buffer per request: previewStore held the buffer for THIRTY
// MINUTES after the upload, so the ceiling was not "two concurrent uploads" but
// "every upload anyone previewed in the last half hour".
//
// So multer streams the body straight to a temp file and hands us a path. The raw
// bytes never sit in the heap at all.
//
// This does NOT make the whole pipeline constant-memory: parsing still builds one
// JS object per row, which is a 5-10x blowup over the file and is what actually
// dominates for a large CSV. That is a separate problem (TODOS.md #2 — the same
// parse also blocks the event loop). What this removes is the part that was pure
// waste: holding raw bytes we had already parsed.
//
// PII: raw merchant CSVs now land on the container's ephemeral disk, which is not
// backed up and dies with the container. That is a strictly better posture than
// either RAM (which we then had to hold for 30 minutes) or Postgres (which IS
// backed up). It is also why every path below is obsessive about deleting them.
// ─────────────────────────────────────────────────────────────────────────────

/** Where temp uploads live. Overridable so a container can point it at a mounted
 *  scratch volume rather than the OS temp dir. */
export const UPLOAD_DIR =
  process.env.UPLOAD_DIR ?? path.join(os.tmpdir(), 'qa-shopify-uploads');

/** An upload older than this is orphaned — nothing will ever come back for it.
 *  Comfortably longer than previewStore's own 30-minute TTL, so the sweep never
 *  pulls a file out from under a preview that is still valid. */
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  // Never trust the client's filename on disk. The original name is preserved
  // separately (req.file.originalname) for display and the report title.
  filename: (_req, _file, cb) => cb(null, `${uuidv4()}.csv`),
});

/**
 * Delete a temp upload. Best-effort and never throws: a file that is already gone
 * is the outcome we wanted, and a cleanup failure must not turn a successful import
 * into a failed request.
 */
export function removeUploadFile(filePath: string | undefined): void {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') {
      console.error(`[upload] could not remove temp file ${filePath}: ${err.message}`);
    }
  });
}

/**
 * Delete temp uploads nobody is coming back for.
 *
 * Every normal path deletes its own file, but a crash between "multer wrote the
 * file" and "the handler consumed it" leaves merchant PII sitting on disk with no
 * one to clean it up. Run on boot (to catch what the last process leaked) and on an
 * interval (to catch what this one does).
 */
export async function sweepOrphanUploads(): Promise<number> {
  const cutoff = Date.now() - ORPHAN_MAX_AGE_MS;
  let removed = 0;

  let entries: string[];
  try {
    entries = await fs.promises.readdir(UPLOAD_DIR);
  } catch {
    return 0;
  }

  for (const name of entries) {
    const filePath = path.join(UPLOAD_DIR, name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        await fs.promises.unlink(filePath);
        removed++;
      }
    } catch {
      // Raced with another sweep or a normal delete. Fine either way.
    }
  }

  if (removed > 0) console.log(`[upload] swept ${removed} orphaned upload file(s)`);
  return removed;
}
