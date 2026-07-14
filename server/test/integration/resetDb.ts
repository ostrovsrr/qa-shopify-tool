import prisma from '../../src/db/prisma';

// ─────────────────────────────────────────────────────────────────────────────
// The one place that knows what a clean integration DB looks like.
//
// Every suite used to hand-roll its own TRUNCATE list, and each one truncated only
// the tables it happened to care about. That worked right up until store_locks
// arrived: a lock outlives the run that took it, and store_locks has no FK to
// anything, so CASCADE from validation_runs / product_upload_runs does NOT clear
// it. One suite that left a live lock behind (a lock whose holder was still
// non-terminal) made a LATER suite's import get refused as "store busy" — a failure
// with no visible connection to its cause.
//
// So: one list, used by everyone. Add a table here, not in a test file.
// ─────────────────────────────────────────────────────────────────────────────

/** Truncate roots — CASCADE clears their children (runs, jobs, rows, results). */
const ROOTS = [
  'product_upload_runs',
  'validation_runs',
  'cleanup_runs',
  'store_locks',
];

export async function resetDb(): Promise<void> {
  for (const table of ROOTS) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);
  }
}
