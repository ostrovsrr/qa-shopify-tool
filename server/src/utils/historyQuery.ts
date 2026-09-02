import type { Request } from 'express';
import { actorKey } from '../services/actionLog.service';
import { HistoryQuery, clampHistoryLimit } from '../services/customerValidation.service';

// ─────────────────────────────────────────────────────────────────────────────
// Parse ?createdBy= and ?limit= for the two history endpoints.
//
// Shared by the customer and product controllers because they are twins and this
// must not drift between them: a filter that behaves differently on /products
// than on /customers is worse than no filter, because a colleague learns one
// behaviour and then trusts it in the other place.
//
// ── AGAIN: A VIEW, NOT A PERMISSION ─────────────────────────────────────────
//
// createdBy narrows a LIST. It decides nothing about access. Every row is still
// readable by anyone who asks without the parameter, exactly as before — this
// endpoint got no new authority, and must never be given any, because the value
// it filters on is caller-supplied.
// ─────────────────────────────────────────────────────────────────────────────

/** `?createdBy=me` means "whoever this request says it is" — resolved from the
 *  X-QA-User header, so the client never has to repeat its own name in the URL
 *  and the two can never disagree. */
const SELF = 'me';

export function parseHistoryQuery(req: Request): HistoryQuery {
  const rawCreatedBy =
    typeof req.query.createdBy === 'string' ? req.query.createdBy : undefined;

  let createdBy: string | undefined;
  if (rawCreatedBy !== undefined && rawCreatedBy !== '') {
    const wanted =
      rawCreatedBy === SELF
        ? (req.header('x-qa-user') ?? '')
        : rawCreatedBy;
    // The COMPARISON form, not the display form. Rows store what the person typed
    // ("Josh"), so the filter lowercases both sides -- here, and again in the
    // database query, which must be case-insensitive or this key matches nothing.
    createdBy = actorKey(wanted) || undefined;

    // Asked to filter by self, but this browser has not picked a name yet. Rows
    // are stored as 'unknown' in that case, so match those rather than silently
    // widening to everyone — the caller asked for a narrower list, and quietly
    // handing back the full one is the kind of surprise that erodes trust in it.
    if (createdBy === undefined) createdBy = 'unknown';
  }

  const rawLimit =
    typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;

  return {
    createdBy,
    limit: clampHistoryLimit(rawLimit),
  };
}
