import { describe, expect, it, beforeAll } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { SignJWT, generateKeyPair } from 'jose';
import type { KeyLike } from 'jose';
import { makeAccessAuth, accessConfigFromEnv } from '../src/middleware/accessAuth';

// ─────────────────────────────────────────────────────────────────────────────
// The Cloudflare Access gate is the one piece of this branch that cannot be
// exercised by driving the app in a browser — there is no Cloudflare in front of
// localhost. So it gets the real test: mint tokens with a locally-generated key,
// hand the middleware the matching public key, and assert exactly which tokens
// get in. If verification ever silently degrades to "any token", these go red.
// ─────────────────────────────────────────────────────────────────────────────

const ISSUER = 'https://team.cloudflareaccess.com';
const AUD = 'app-aud-tag-123';

let privateKey: KeyLike;
let publicKey: KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

/** Mint a signed token. Overrides let each test bend one claim. */
async function mint(
  overrides: {
    email?: string | null;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
    signWith?: KeyLike;
  } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (overrides.email !== null) claims.email = overrides.email ?? 'rodion@company.com';

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUD)
    .setExpirationTime(overrides.expiresIn ?? '1h')
    .sign(overrides.signWith ?? privateKey);
}

/** A fake req/res/next that records what the middleware did. */
function harness(headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const req = {
    accessEmail: undefined as string | undefined,
    requestId: 'test-req',
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;

  const recorded = { status: undefined as number | undefined, body: undefined as unknown, nextCalled: false };

  const res = {
    status(code: number) {
      recorded.status = code;
      return this;
    },
    json(payload: unknown) {
      recorded.body = payload;
      return this;
    },
  } as unknown as Response;

  const next: NextFunction = () => {
    recorded.nextCalled = true;
  };

  return { req, res, next, recorded };
}

const enabled = () =>
  makeAccessAuth({ enabled: true, issuer: ISSUER, audience: AUD, keyResolver: publicKey });

describe('Cloudflare Access middleware', () => {
  it('accepts a valid token, calls next, and attaches the verified email', async () => {
    const h = harness({ 'Cf-Access-Jwt-Assertion': await mint({ email: 'rodion@company.com' }) });
    await enabled()(h.req, h.res, h.next);

    expect(h.recorded.nextCalled).toBe(true);
    expect(h.recorded.status).toBeUndefined();
    expect(h.req.accessEmail).toBe('rodion@company.com');
  });

  it('rejects a request with no token — 401', async () => {
    const h = harness({});
    await enabled()(h.req, h.res, h.next);

    expect(h.recorded.nextCalled).toBe(false);
    expect(h.recorded.status).toBe(401);
    expect(h.req.accessEmail).toBeUndefined();
  });

  it('rejects a token minted for a different Access application (wrong aud) — 401', async () => {
    const h = harness({ 'Cf-Access-Jwt-Assertion': await mint({ audience: 'some-other-app' }) });
    await enabled()(h.req, h.res, h.next);

    expect(h.recorded.nextCalled).toBe(false);
    expect(h.recorded.status).toBe(401);
  });

  it('rejects a token from a different team (wrong issuer) — 401', async () => {
    const h = harness({
      'Cf-Access-Jwt-Assertion': await mint({ issuer: 'https://evil.cloudflareaccess.com' }),
    });
    await enabled()(h.req, h.res, h.next);

    expect(h.recorded.nextCalled).toBe(false);
    expect(h.recorded.status).toBe(401);
  });

  it('rejects an expired token — 401', async () => {
    const h = harness({ 'Cf-Access-Jwt-Assertion': await mint({ expiresIn: '-1h' }) });
    await enabled()(h.req, h.res, h.next);

    expect(h.recorded.nextCalled).toBe(false);
    expect(h.recorded.status).toBe(401);
  });

  it('rejects a token signed by the wrong key (forged) — 401', async () => {
    const attacker = await generateKeyPair('RS256');
    const h = harness({
      'Cf-Access-Jwt-Assertion': await mint({ signWith: attacker.privateKey }),
    });
    await enabled()(h.req, h.res, h.next);

    expect(h.recorded.nextCalled).toBe(false);
    expect(h.recorded.status).toBe(401);
  });

  it('rejects a verified token that carries no identity — 403', async () => {
    const h = harness({ 'Cf-Access-Jwt-Assertion': await mint({ email: null }) });
    await enabled()(h.req, h.res, h.next);

    expect(h.recorded.nextCalled).toBe(false);
    expect(h.recorded.status).toBe(403);
  });

  it('fails CLOSED when enabled but no key resolver is configured — 500, never open', async () => {
    const broken = makeAccessAuth({ enabled: true, issuer: ISSUER, audience: AUD });
    const h = harness({ 'Cf-Access-Jwt-Assertion': await mint() });
    await broken(h.req, h.res, h.next);

    expect(h.recorded.nextCalled).toBe(false);
    expect(h.recorded.status).toBe(500);
  });
});

describe('accessAuth passthrough (local dev)', () => {
  it('lets every request through untouched when disabled', async () => {
    const passthrough = makeAccessAuth({ enabled: false });
    const h = harness({}); // no token at all
    await passthrough(h.req, h.res, h.next);

    expect(h.recorded.nextCalled).toBe(true);
    expect(h.recorded.status).toBeUndefined();
    expect(h.req.accessEmail).toBeUndefined();
  });
});

describe('accessConfigFromEnv', () => {
  it('is disabled when the env vars are absent', () => {
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    delete process.env.CF_ACCESS_AUD;
    expect(accessConfigFromEnv().enabled).toBe(false);
  });

  it('is enabled and derives issuer + JWKS URL from a bare team domain', () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = 'myteam.cloudflareaccess.com';
    process.env.CF_ACCESS_AUD = 'aud-tag';
    const cfg = accessConfigFromEnv();
    expect(cfg.enabled).toBe(true);
    expect(cfg.issuer).toBe('https://myteam.cloudflareaccess.com');
    expect(cfg.audience).toBe('aud-tag');
    expect(cfg.keyResolver).toBeTypeOf('function');
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    delete process.env.CF_ACCESS_AUD;
  });
});
