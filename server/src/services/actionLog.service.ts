import type { Request } from 'express';
import prisma from '../db/prisma';

// ─────────────────────────────────────────────────────────────────────────────
// WHO DID THAT?
//
// The tool has six routes that destroy things, and four of them delete records from
// a REAL Shopify store, BY TAG, ACROSS THE WHOLE STORE. In a shared workspace any
// colleague can fire any of them at any store, and the busy-lock only stops them
// doing it AT THE SAME TIME as someone else — not five minutes later, while a
// colleague is still reading the report.
//
// So the destructive actions are logged. Not to prevent them: to make them legible
// afterwards, when someone asks "where did my QA products go?"
//
// ── ATTRIBUTION IS NOT AUTHORIZATION ────────────────────────────────────────
//
// The actor is supplied by the CLIENT (a name the colleague picked, held in their
// browser). Anyone can send any name. That is FINE for what this is for — the
// failure mode it addresses is a mistake, not an attack, and the people involved
// all have legitimate access already.
//
// It is DISQUALIFYING for anything else. `actor` and `createdBy` must never appear
// in a WHERE clause that decides what someone is allowed to see or do. That would
// be an authorization system built on a value the attacker controls — the worst of
// both worlds, because it would also LOOK like security.
//
// When Cloudflare Access lands, the identity comes from the verified Cf-Access JWT
// and this header stops being trusted for anything. Until then it is a label.
// ─────────────────────────────────────────────────────────────────────────────

export type DestructiveAction =
  | 'DELETE_VALIDATION_RUN'
  | 'DELETE_PRODUCT_UPLOAD'
  | 'CLEANUP_STORE_CUSTOMERS'
  | 'CLEANUP_STORE_PRODUCTS'
  | 'CLEANUP_IMPORT_CUSTOMERS'
  | 'CLEANUP_IMPORT_PRODUCTS';

const ACTOR_HEADER = 'x-qa-user';
const MAX_ACTOR_LENGTH = 60;

/**
 * Who is making this request, as far as we can tell.
 *
 * Sanitised, not verified. The point of the sanitising is that this string ends up
 * in a database column and in logs, not that it establishes identity — it cannot.
 */
/**
 * An opaque slug: a first name or handle. NOT an email — this value lands in the
 * history UI and in logs, and there is no reason for it to carry an identifier
 * more personal than the tool actually needs.
 *
 * CASE IS PRESERVED, because this string is displayed: the history reads
 * "by Rodion", not "by rodion". It is therefore NOT a comparison key — use
 * actorKey() for that, and never compare two of these with ===.
 *
 * Exported because the history FILTER has to sanitise a query param exactly the
 * way the writer sanitised the header, or "?createdBy=Josh!" and the stored "Josh"
 * would differ by a character the writer had already stripped.
 */
export function normalizeActor(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, MAX_ACTOR_LENGTH);
}

/**
 * The comparison form. "Josh", "josh" and "JOSH" are one person.
 *
 * Kept separate from what gets STORED, on purpose. Lowercasing on write would make
 * the display name a casualty of the lookup; matching case-sensitively would split
 * one colleague into three depending on how they capitalised themselves the day
 * they typed it. So: store what they typed, match without regard to case.
 *
 * Anything comparing actors — the history filter, "?createdBy=me" — must go through
 * here, and the database comparison must be case-insensitive to match.
 */
export function actorKey(raw: string): string {
  return normalizeActor(raw).toLowerCase();
}

export function actorFrom(req: Request): string {
  const raw = req.header(ACTOR_HEADER);
  if (!raw) return 'unknown';
  return normalizeActor(raw) || 'unknown';
}

interface LogEntry {
  action: DestructiveAction;
  /** The run id, upload id, or store id the action was aimed at. */
  target: string;
  /** The Shopify store, when the action reached one. */
  storeId?: string | null;
  /** Anything worth knowing later — the tag, the count, the run reversed.
   *  NEVER raw CSV data: this table is not a PII sink. */
  detail?: Record<string, unknown>;
}

/**
 * Record a destructive action. Best-effort and never throws.
 *
 * A failure to WRITE THE LOG must not fail the action the user asked for. The log is
 * for forensics; refusing a cleanup because the audit insert hiccuped would be a
 * worse outcome than a missing log line.
 */
export async function recordAction(req: Request, entry: LogEntry): Promise<void> {
  try {
    await prisma.actionLog.create({
      data: {
        actor: actorFrom(req),
        action: entry.action,
        target: entry.target,
        storeId: entry.storeId ?? null,
        detail: (entry.detail ?? {}) as object,
      },
    });
  } catch (err) {
    console.error(`[audit] could not record ${entry.action}: ${(err as Error).message}`);
  }
}

/** The destructive-action history, newest first. Read-only: nothing in the app makes
 *  a decision from this table. */
export async function getActionLog(limit = 200): Promise<
  { id: string; actor: string; action: string; target: string; storeId: string | null; detail: unknown; createdAt: Date }[]
> {
  return prisma.actionLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 500),
  });
}
