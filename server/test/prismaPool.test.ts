import { describe, expect, it } from 'vitest';
import { withPoolSettings } from '../src/db/prisma';

// ─────────────────────────────────────────────────────────────────────────────
// Prisma's default pool is num_cpus*2+1 — THREE connections on a 1-vCPU container.
// This app holds connections for up to 120 seconds at a stretch (the bulk-result
// merges, the validate persist, the product upload all open interactive
// transactions, because a large CSV really does take that long to write).
//
// Three connections against 120-second transactions means three concurrent uploads
// exhaust the pool, and everyone else — including the status polls of imports that
// are running fine — gets a DB timeout that looks like nothing in particular.
//
// The setting lives in a URL query parameter, which is exactly the kind of thing
// that silently reverts. Nobody would trace "the tool randomly errors under load"
// back to a missing querystring, so it is pinned here.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 'postgresql://postgres:pw@localhost:5432/shopify_csv_qa';

describe('database connection pool sizing', () => {
  it('sizes the pool for the long transactions, not the CPU count', () => {
    const url = new URL(withPoolSettings(BASE));

    expect(url.searchParams.get('connection_limit')).toBe('10');
    // Prisma's default pool_timeout is 10s, which a 120s transaction outlasts
    // trivially — so a heavy writer would fail every reader queued behind it.
    expect(url.searchParams.get('pool_timeout')).toBe('30');
  });

  it('leaves the rest of the connection string alone', () => {
    const url = new URL(withPoolSettings(BASE));

    expect(url.protocol).toBe('postgresql:');
    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/shopify_csv_qa');
    expect(url.username).toBe('postgres');
  });

  it('preserves existing query params (sslmode, schema, pgbouncer…)', () => {
    const url = new URL(withPoolSettings(`${BASE}?sslmode=require&schema=public`));

    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('schema')).toBe('public');
    expect(url.searchParams.get('connection_limit')).toBe('10');
  });

  it('never overrides a limit the operator set explicitly', () => {
    // If someone tuned this for their database, that decision wins — a hosted
    // Postgres with a low max_connections may not tolerate 10 per process, and a
    // rolling deploy briefly runs two processes.
    const url = new URL(withPoolSettings(`${BASE}?connection_limit=2&pool_timeout=5`));

    expect(url.searchParams.get('connection_limit')).toBe('2');
    expect(url.searchParams.get('pool_timeout')).toBe('5');
  });

  it('accepts an override for the limit', () => {
    const url = new URL(withPoolSettings(BASE, 25, 45));

    expect(url.searchParams.get('connection_limit')).toBe('25');
    expect(url.searchParams.get('pool_timeout')).toBe('45');
  });

  it('hands back an unparseable connection string untouched rather than breaking it', () => {
    // Better to run with Prisma's defaults than to mangle a connection string that
    // presumably works.
    expect(withPoolSettings('not-a-url')).toBe('not-a-url');
  });
});
