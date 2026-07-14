// ─────────────────────────────────────────────────────────────────────────────
// Errors whose message is SAFE TO SHOW A USER.
//
// The generic 500 handler assumes the opposite by default: an unexpected error's
// message is written for whoever is reading the logs, not for a colleague in a
// browser, and it routinely contains connection strings, file paths, SQL, and
// Shopify tokens. So the handler shows a generic sentence and a correlation id,
// and keeps the detail server-side.
//
// But some failures are genuinely ABOUT the user's input, and hiding those is its
// own kind of unhelpful: "something went wrong" when the real answer is "line 42 of
// your CSV has an unterminated quote" turns a 10-second fix into a support thread.
//
// An HttpError is the explicit statement that a message was written FOR the user
// and may be shown to them. Anything that is not an HttpError is assumed unsafe.
// ─────────────────────────────────────────────────────────────────────────────

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** The uploaded CSV could not be parsed. The parser's complaint is about the FILE
 *  ("Quote Not Closed... at line 2"), which is exactly what the user needs to know
 *  and reveals nothing about the server. */
export class CsvParseError extends HttpError {
  constructor(detail: string) {
    super(400, `Could not read that CSV: ${detail}`);
    this.name = 'CsvParseError';
  }
}
