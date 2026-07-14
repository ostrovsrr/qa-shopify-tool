import { PrismaClient } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────────
// THE CONNECTION POOL.
//
// Prisma's default pool size is `num_cpus * 2 + 1`. On the 1-vCPU container this
// app is destined for, that is THREE connections — and this app holds connections
// for a very long time. Five code paths open interactive transactions with a
// 120-second timeout (the bulk-result merges, the validate persist, the product
// upload), because a large CSV genuinely takes that long to write.
//
// Three connections against 120-second transactions means three concurrent uploads
// exhaust the pool outright. Everyone else — including the status polls of imports
// that are running perfectly well — then waits, and after pool_timeout gets a DB
// error that looks like nothing in particular. The tool appears broken, at random,
// for people who did nothing wrong.
//
// This was invisible locally: one user, one operation, one connection.
//
// The fix is to size the pool for the transactions we actually hold, not for the
// CPU count. The long transactions themselves are FINE — they are already batched
// with createMany at CHUNK 5000. Do not "optimize" them; size the pool instead.
// ─────────────────────────────────────────────────────────────────────────────

/** Connections per process. Room for the long writers plus the short polls and
 *  reads that must not queue behind them. Keep it comfortably under the database's
 *  own max_connections, remembering that a rolling deploy runs TWO processes at
 *  once and each opens its own pool. */
const DEFAULT_CONNECTION_LIMIT = 10;

/** Seconds a query waits for a free connection before giving up. Prisma's default
 *  is 10s, which a 120-second transaction can trivially outlast. Long enough to
 *  ride out a heavy writer; short enough that a genuinely wedged pool surfaces as
 *  an error rather than a hang. */
const DEFAULT_POOL_TIMEOUT_S = 30;

/**
 * Add pool settings to the connection string, without clobbering anything the
 * operator set explicitly.
 *
 * Exported for tests: getting this wrong silently reverts us to a pool of 3, and
 * the symptom (random DB timeouts under concurrency) is one nobody would trace back
 * to a URL query parameter.
 */
export function withPoolSettings(
  url: string,
  connectionLimit: number = DEFAULT_CONNECTION_LIMIT,
  poolTimeoutS: number = DEFAULT_POOL_TIMEOUT_S,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL we can parse — hand it back untouched rather than breaking a
    // connection string that presumably works.
    return url;
  }

  // An explicit setting in the URL is the operator's decision and wins.
  if (!parsed.searchParams.has('connection_limit')) {
    parsed.searchParams.set('connection_limit', String(connectionLimit));
  }
  if (!parsed.searchParams.has('pool_timeout')) {
    parsed.searchParams.set('pool_timeout', String(poolTimeoutS));
  }

  return parsed.toString();
}

function datasourceUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;

  const limit = Number(process.env.DATABASE_CONNECTION_LIMIT) || DEFAULT_CONNECTION_LIMIT;
  return withPoolSettings(url, limit);
}

const url = datasourceUrl();

const prisma = new PrismaClient(
  url ? { datasources: { db: { url } } } : undefined,
);

export default prisma;
