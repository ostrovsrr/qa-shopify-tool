import { v4 as uuidv4 } from 'uuid';

const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface PreviewEntry {
  fileName: string;
  buffer: Buffer;
  headers: string[];
  sampleRows: Record<string, string>[];
  createdAt: Date;
}

const store = new Map<string, PreviewEntry>();

export function storePreview(entry: Omit<PreviewEntry, 'createdAt'>): string {
  const uploadId = uuidv4();
  store.set(uploadId, { ...entry, createdAt: new Date() });
  // Evict expired entries on every write to keep memory bounded
  const cutoff = Date.now() - TTL_MS;
  for (const [id, e] of store.entries()) {
    if (e.createdAt.getTime() < cutoff) store.delete(id);
  }
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
