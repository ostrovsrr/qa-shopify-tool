import { v4 as uuidv4 } from 'uuid';
import { removeUploadFile } from './uploadFile';

// ─────────────────────────────────────────────────────────────────────────────
// The bridge between /preview (upload + parse headers) and /validate (apply the
// column mapping and run the rules).
//
// This used to hold the ENTIRE uploaded CSV as a Buffer, for the full 30-minute
// TTL. That made it the single worst memory consumer in the app: not one 100 MB
// buffer per in-flight request, but one per CSV anybody had previewed in the last
// half hour — and a colleague who uploads, wanders off to a meeting, and comes back
// is the normal case, not the pathological one. On a 512 MB container that is an
// OOM, and an OOM kills every other colleague's in-flight import with it.
//
// It now holds a PATH to the temp file multer streamed to disk. The entry owns that
// file: whoever deletes the entry deletes the file with it, so there is exactly one
// place responsible for it and no way to drop the reference without unlinking.
// ─────────────────────────────────────────────────────────────────────────────

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface PreviewEntry {
  fileName: string;
  /** Temp file on disk holding the raw CSV, owned by this entry. */
  filePath: string;
  headers: string[];
  sampleRows: Record<string, string>[];
  createdAt: Date;
}

const store = new Map<string, PreviewEntry>();

/** Drop the entry AND the file it owns. The two must never come apart: an entry
 *  removed without its file leaks merchant PII onto disk with nobody left holding
 *  a reference to it. */
function discard(uploadId: string, entry: PreviewEntry): void {
  store.delete(uploadId);
  removeUploadFile(entry.filePath);
}

function evictExpired(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, e] of store.entries()) {
    if (e.createdAt.getTime() < cutoff) discard(id, e);
  }
}

// Expired previews must be freed even when no further upload arrives to trigger
// the on-write eviction — otherwise an abandoned preview's temp file sits on disk
// indefinitely. unref() keeps the timer from holding the process open (tests,
// graceful shutdown).
setInterval(evictExpired, SWEEP_INTERVAL_MS).unref();

export function storePreview(entry: Omit<PreviewEntry, 'createdAt'>): string {
  const uploadId = uuidv4();
  store.set(uploadId, { ...entry, createdAt: new Date() });
  evictExpired();
  return uploadId;
}

export function getPreview(uploadId: string): PreviewEntry | undefined {
  const entry = store.get(uploadId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt.getTime() > TTL_MS) {
    discard(uploadId, entry);
    return undefined;
  }
  return entry;
}

/** Free a preview once it has served its purpose (the validate step consumed it)
 *  rather than leaving its file on disk until the TTL. */
export function deletePreview(uploadId: string): void {
  const entry = store.get(uploadId);
  if (entry) discard(uploadId, entry);
}
