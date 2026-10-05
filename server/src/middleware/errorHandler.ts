import { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { HttpError } from '../errors';
import { ShopifyAuthError, ShopifyConfigError } from '../services/shopifyClient';

// ─────────────────────────────────────────────────────────────────────────────
// THE ERROR HANDLER, AND THE CORRELATION ID THAT MAKES IT USABLE.
//
// The old handler ended with:
//
//     res.status(500).json({ error: err.message ?? 'Internal server error.' })
//
// which hands an unexpected error's message straight to the browser. That message
// was written for whoever reads the logs, not for a colleague on a web page, and in
// this app it can carry the DATABASE_URL (password and all), absolute file paths, a
// Shopify token, or a chunk of SQL. Locally that is a debugging convenience,
// because the only person reading it is the person who wrote it. Hosted, it is a
// credential leak triggered by any unhandled bug.
//
// But a generic 500 alone makes the tool undebuggable: a colleague says "it broke"
// and there is no way to connect that to any line in the log. So every request gets
// a correlation id, returned in the body and the X-Request-Id header. The user
// quotes eight characters; the log has the stack.
//
// Show the user: an HttpError (a message deliberately written FOR them), and the
// Shopify config/auth failures they can actually act on.
// Show the logs: everything.
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/** Tag every request so a user-visible failure can be found in the log. Honours an
 *  upstream id (a proxy or tunnel may already have set one) so the trace survives
 *  across hops. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const upstream = req.header('x-request-id');
  req.requestId = upstream && upstream.length <= 200 ? upstream : uuidv4();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/** The short form a human reads back over chat. */
function shortId(id: string | undefined): string {
  return (id ?? 'unknown').slice(0, 8);
}

// ── Log scrub (D13) ─────────────────────────────────────────────────────────
//
// The logs are the one place merchant PII leaks by accident rather than by design.
// Nothing deliberately logs a CSV row — but an error message routinely quotes the
// value that caused it ("invalid email: jane.doe@acme.com"), and the logs live
// longer than the data does, outlive the retention purge, and get shipped to
// whatever the platform's log aggregator is.
//
// So the two identifiers we actually handle in bulk are redacted on the way out.
// This is a backstop, not a licence: do not log user data on purpose.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// A phone-SHAPED candidate: an optional +, then 2–7 groups of 1–4 digits (the first
// may be parenthesised) joined by at most one space, dot or hyphen. It must stand
// alone: not glued to a word character, a slash, colon or hyphen on either side, so
// it never starts inside a gid://shopify/Customer/123… path, a UUID, or the middle
// of an ISO timestamp (2026-10-05T14:58:05 is followed by "T"; "2026-10-05 14:58"
// by ":"). A trailing sentence period is fine; a decimal point is not.
//
// The old pattern (/\+?\d[\d\s().-]{8,}\d/) turned every ISO date and every long
// numeric id in the log into "[phone]", which made the log useless for exactly the
// debugging it exists for.
const PHONE_CANDIDATE_RE =
  /(?<![\w/:+-]|\d\.)\+?(?:\(\d{1,4}\)|\d{1,4})(?:[\s.-]?(?:\(\d{1,4}\)|\d{1,4})){1,6}(?![\w/:-]|\.\d)/g;

/** Does this phone-shaped candidate carry enough digits to be a phone number? */
function looksLikePhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '').length;
  // E.164 caps a number at 15 digits; anything longer is an id or a list of counts.
  if (digits > 15) return false;
  // An explicit + is an international number: as few as 8 digits is real.
  if (candidate.startsWith('+')) return digits >= 8;
  // Written with separators (613-555-0104, (613) 555-0104): 9+ digits. An ISO date
  // (2026-10-05) has 8 and so survives.
  if (/[\s().-]/.test(candidate)) return digits >= 9;
  // A bare digit run is ambiguous with ids and epoch timestamps. Shopify ids are
  // 13+ digits and epoch milliseconds 13; a national number (6135550104) is 10, and
  // one with its country code but no + (16135550104, 442071234567) 11–12.
  return digits >= 10 && digits <= 12;
}

export function scrub(text: string): string {
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(PHONE_CANDIDATE_RE, (match) => (looksLikePhone(match) ? '[phone]' : match));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const id = req.requestId ?? uuidv4();

  // The full detail goes HERE, where only we can see it. Stack included: it is the
  // whole reason the correlation id is worth having.
  //
  // Scrubbed, though: an error message routinely quotes the value that caused it
  // ("invalid email: jane@acme.com"), and logs outlive the retention purge.
  console.error(`[error] ${shortId(id)} ${req.method} ${req.path} — ${scrub(err.message)}`);
  if (err.stack) console.error(scrub(err.stack));

  // ── Failures whose message was written for the user ────────────────────────

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res
        .status(413)
        .json({ error: 'File is too large. The maximum upload size is 100 MB.', requestId: id });
      return;
    }
    res.status(400).json({ error: err.message, requestId: id });
    return;
  }

  if (err instanceof ShopifyConfigError) {
    res.status(503).json({
      error: err.message,
      hint: 'Check the Shopify store configuration in the server environment.',
      requestId: id,
    });
    return;
  }

  if (err instanceof ShopifyAuthError) {
    res.status(401).json({ error: err.message, requestId: id });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, requestId: id });
    return;
  }

  // body-parser (express.json) and other http-errors-style failures: malformed JSON
  // (400 entity.parse.failed), a body over the limit (413 entity.too.large), a bad
  // charset (415). They are the CLIENT's fault, say so with their own status, and
  // mark themselves expose:true — their messages are written to be shown. They used
  // to become a 500 "something went wrong on our end", which is wrong on both counts.
  // Only a 4xx that explicitly opts in: a 5xx, or anything without expose, is still
  // treated as unfit to be seen.
  const clientError = err as Error & { status?: unknown; statusCode?: unknown; expose?: unknown };
  const status = typeof clientError.status === 'number' ? clientError.status : clientError.statusCode;
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    clientError.expose === true
  ) {
    res.status(status).json({ error: err.message, requestId: id });
    return;
  }

  // ── Everything else: assume the message is not fit to be seen ──────────────
  //
  // Not "Internal server error" on its own, which tells the user nothing and gives
  // them nothing to say when they ask for help. The id is the whole point.
  res.status(500).json({
    error: `Something went wrong on our end. Quote reference ${shortId(id)} if you report this.`,
    requestId: id,
  });
}
