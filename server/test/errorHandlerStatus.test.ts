import { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../src/middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// Which http-errors-style errors may show their message.
//
// express.json() (body-parser) fails with errors that carry `status` and
// `expose`. A 4xx with expose:true is the client's mistake, written to be shown,
// and keeps its status. Anything else — a 5xx, or a 4xx that did not opt in — is
// still the generic 500 with a reference: its message was not written for users.
// ─────────────────────────────────────────────────────────────────────────────

function run(err: Error): { status: number; body: { error: string; requestId: string } } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const req = { method: 'POST', path: '/api/x', requestId: 'req-12345678' } as Request;
  errorHandler(err, req, res as unknown as Response, (() => undefined) as NextFunction);
  return { status: res.statusCode, body: res.body as { error: string; requestId: string } };
}

function httpError(message: string, props: Record<string, unknown>): Error {
  return Object.assign(new Error(message), props);
}

describe('errorHandler and http-errors statuses', () => {
  afterEach(() => vi.restoreAllMocks());

  it('honours an exposed 4xx: status and message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = run(
      httpError('request entity too large', {
        status: 413,
        statusCode: 413,
        expose: true,
        type: 'entity.too.large',
      }),
    );

    expect(out.status).toBe(413);
    expect(out.body.error).toBe('request entity too large');
    expect(out.body.requestId).toBe('req-12345678');
  });

  it('does not expose a 4xx that did not opt in', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = run(httpError('internal detail /srv/secret', { status: 400, expose: false }));

    expect(out.status).toBe(500);
    expect(out.body.error).not.toContain('/srv/secret');
  });

  it('never exposes a 5xx, even one that claims expose:true', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = run(httpError('db password hunter2', { status: 503, expose: true }));

    expect(out.status).toBe(500);
    expect(out.body.error).not.toContain('hunter2');
    expect(out.body.error).toMatch(/something went wrong/i);
  });
});
