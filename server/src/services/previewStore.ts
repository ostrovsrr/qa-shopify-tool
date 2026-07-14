import { v4 as uuidv4 } from 'uuid';

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface PreviewEntry {
  fileName: string;
  buffer: Buffer;
  headers: string[];
  sampleRows: Record<string, string>[];
  createdAt: Date;
}

const store = new Map<string, PreviewEntry>();

function evictExpired(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, e] of store.entries()) {
    if (e.createdAt.getTime() < cutoff) store.delete(id);
  }
}

// Entries hold the full uploaded CSV buffer (up to 100 MB each), so expired
// previews must be freed even when no further upload arrives to trigger the
// on-write eviction. unref() keeps the timer from holding the process open
// (tests, graceful shutdown).
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
    store.delete(uploadId);
    return undefined;
  }
  return entry;
}

/** Free a preview's buffer once it has served its purpose (e.g. the validate
 *  step consumed it) instead of holding the file in memory until the TTL. */
export function deletePreview(uploadId: string): void {
  store.delete(uploadId);
}
