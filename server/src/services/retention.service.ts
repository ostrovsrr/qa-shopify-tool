import prisma from '../db/prisma';
import { TERMINAL_BULK_STATUSES } from './shopifyBulk';

// ─────────────────────────────────────────────────────────────────────────────
// PII RETENTION.
//
// The tool stores merchant customer data: names, emails, phone numbers, addresses.
// Colleagues hand us a CSV for one QA pass and it then sits in Postgres forever,
// because nothing has ever deleted anything. On one laptop that is a bad habit.
// Hosted, on a shared box, with backups, it is an accumulating liability that
// nobody signed up for.
//
// ── WHY WE PURGE ROWS, NOT RUNS ─────────────────────────────────────────────
//
// The obvious retention policy — "delete runs older than N days" — is a P0 bug in
// this codebase, because OriginalCustomerRow / ProductOriginalRow are NOT an
// archive. They are a LIVE DEPENDENCY:
//
//   - shopifyImport.service rebuilds the import dataset from them (deterministically,
//     which is how bulk results are mapped back to CSV rows),
//   - the Excel reports are built from them,
//   - resume-on-boot recomputes a job's slice from them.
//
// Delete the rows out from under a RUNNING import and it cannot reconcile: the tool
// would not just lose history, it would lose the ability to tell the truth about an
// import that is happening right now.
//
// So: purge the SOURCE ROWS (which are the PII) and keep the AGGREGATE RESULTS
// (issue counts, accepted/rejected per row number — no personal data). The QA
// history stays useful; the personal data does not survive. And a run with any
// non-terminal import is never touched.
//
// ── ALIGNMENT, OR THIS IS THEATRE ───────────────────────────────────────────
//
// A 30-day purge on a database with 35-day point-in-time-recovery deletes nothing:
// the data is still in the backups, restorable, for longer than the policy claims.
// RETENTION_DAYS must be >= the platform's PITR/backup window, or the number in
// this file is a story we tell ourselves. Whoever configures the database is the
// one who has to make that true. See docs/DEPLOY.md.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Days a run's raw uploaded rows are kept. UNSET OR 0 = NEVER PURGE.
 *
 * ── WHY THIS DEFAULTS TO OFF ────────────────────────────────────────────────
 *
 * It used to default to 30, and that was a genuinely bad call. On 2026-07-14 the
 * dev server was restarted after a routine migration and the boot-time purge
 * immediately and irreversibly deleted the raw rows of 47 real validation runs —
 * months of a colleague's work — because nobody had set a variable they did not
 * know existed. No warning, no dry run, no confirmation. The data was not
 * recoverable.
 *
 * A destructive, irreversible sweep must never run because someone FORGOT to
 * configure something. The safe state has to be the default state. Retention is now
 * opt-in: you set a number, on purpose, having thought about it.
 *
 * The cost of this default is that PII lives forever until someone turns retention
 * on. That is a real cost, and it is the smaller one: unset retention is a liability
 * you can fix any day; deleted merchant data is gone.
 */
export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 0);

export interface PurgeSummary {
  validationRuns: number;
  productUploads: number;
  /** Runs that were old enough but are still being imported — deliberately spared. */
  skippedInFlight: number;
}

function cutoff(): Date {
  return new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Delete the raw uploaded rows of runs past the retention window.
 *
 * COMPANION RULE: a run with any non-terminal import is skipped, however old it is.
 * Its rows are not history, they are the input to work that has not finished — the
 * reconcile rebuilds the import dataset from them to map Shopify's results back to
 * CSV rows. Purging those would leave an import that can never be reconciled and can
 * never tell anyone what it did.
 */
export async function purgeExpiredPii(): Promise<PurgeSummary> {
  const summary: PurgeSummary = { validationRuns: 0, productUploads: 0, skippedInFlight: 0 };
  if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS <= 0) return summary;

  const before = cutoff();

  // ── SAY WHAT YOU ARE ABOUT TO DESTROY, BEFORE YOU DESTROY IT ──────────────
  //
  // The first run of this against a database with real history in it deleted 47
  // runs' worth of raw rows and said nothing until afterwards. An irreversible
  // sweep gets to announce itself: count the victims, print the number, and — the
  // first time it would delete anything — REFUSE, until a human has seen the number
  // and said yes.
  //
  // RETENTION_CONFIRMED=1 is that yes. It is deliberately a second, separate
  // variable: setting RETENTION_DAYS is a policy decision, and confirming that you
  // accept what it will delete from THIS database, right now, is a different one.
  const doomed =
    (await prisma.validationRun.count({ where: { createdAt: { lt: before }, piiPurgedAt: null } })) +
    (await prisma.productUploadRun.count({
      where: { createdAt: { lt: before }, piiPurgedAt: null },
    }));

  if (doomed > 0 && process.env.RETENTION_CONFIRMED !== '1') {
    console.warn(
      `[retention] REFUSING TO PURGE. RETENTION_DAYS=${RETENTION_DAYS} would irreversibly ` +
        `delete the uploaded rows of ${doomed} existing run(s) (everything before ` +
        `${before.toISOString().slice(0, 10)}). Their reports could no longer be rebuilt.\n` +
        `[retention] If that is what you want, set RETENTION_CONFIRMED=1. ` +
        `To keep the data, set RETENTION_DAYS=0.`,
    );
    return summary;
  }

  // ── customers ─────────────────────────────────────────────────────────────
  const staleValidations = await prisma.validationRun.findMany({
    where: { createdAt: { lt: before }, piiPurgedAt: null },
    select: { id: true, importRuns: { select: { status: true } } },
  });

  for (const run of staleValidations) {
    if (run.importRuns.some((i) => !TERMINAL_BULK_STATUSES.includes(i.status))) {
      summary.skippedInFlight++;
      continue;
    }
    await prisma.$transaction([
      prisma.originalCustomerRow.deleteMany({ where: { validationRunId: run.id } }),
      // affectedRows is a JSON snapshot of the flagged rows — it is CSV data too, so
      // it goes with them. Keeping it would defeat the whole exercise.
      prisma.validationRun.update({
        where: { id: run.id },
        data: { piiPurgedAt: new Date(), affectedRows: [] },
      }),
    ]);
    summary.validationRuns++;
  }

  // ── products (the twin) ───────────────────────────────────────────────────
  const staleUploads = await prisma.productUploadRun.findMany({
    where: { createdAt: { lt: before }, piiPurgedAt: null },
    select: { id: true, importRuns: { select: { status: true } } },
  });

  for (const upload of staleUploads) {
    if (upload.importRuns.some((i) => !TERMINAL_BULK_STATUSES.includes(i.status))) {
      summary.skippedInFlight++;
      continue;
    }
    await prisma.$transaction([
      prisma.productOriginalRow.deleteMany({ where: { uploadRunId: upload.id } }),
      prisma.productUploadRun.update({
        where: { id: upload.id },
        data: { piiPurgedAt: new Date() },
      }),
    ]);
    summary.productUploads++;
  }

  const purged = summary.validationRuns + summary.productUploads;
  if (purged > 0 || summary.skippedInFlight > 0) {
    console.log(
      `[retention] purged raw rows from ${purged} run(s) older than ${RETENTION_DAYS} days` +
        (summary.skippedInFlight > 0
          ? `; spared ${summary.skippedInFlight} with imports still in flight`
          : ''),
    );
  }
  return summary;
}

/** The message shown wherever a purged run's rows are needed. Says what happened and
 *  why, rather than failing with something that reads like a bug. */
export function purgedMessage(): string {
  return (
    `The uploaded rows for this run were deleted after ${RETENTION_DAYS} days, ` +
    'so its report can no longer be rebuilt. Re-upload the CSV to run it again.'
  );
}
