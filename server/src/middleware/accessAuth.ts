import { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey, KeyLike } from 'jose';

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION — CLOUDFLARE ACCESS
//
// The tool has no login of its own, and it never will: standing up a user store,
// password reset, session cookies and the rest for ~5 colleagues would be more
// attack surface than the thing it guards. Instead the whole app sits behind
// Cloudflare Access. Access authenticates the person at the EDGE (Google / email
// OTP), and on every request it forwards to us it injects a signed JWT in the
// `Cf-Access-Jwt-Assertion` header.
//
// This middleware verifies that JWT — signature against Cloudflare's rotating
// public keys, plus the `aud` (this exact Access application) and `iss` (this
// exact team) claims. A request that reaches us without a valid token did NOT
// come through Access, so it is rejected. Identity then comes from the verified
// `email` claim, which the caller cannot forge — unlike the `X-QA-User` header,
// which is a self-asserted label (see services/actionLog.service.ts).
//
// ── FAIL-CLOSED IN PRODUCTION ────────────────────────────────────────────────
//
// Locally there is no Access in front of the dev server, so with no config this
// middleware is a PASSTHROUGH and identity falls back to the X-QA-User label —
// fine, because the only person reaching localhost is the developer. That same
// passthrough in production would be an unauthenticated public app. So the server
// REFUSES TO BOOT in production without this configured (see index.ts). Auth being
// off must never be something you get by forgetting to set a variable — the same
// lesson the retention purge taught on 2026-07-14.
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The verified email from the Cloudflare Access JWT. Set only when Access
       *  is configured AND the token verified. Absent in local dev. */
      accessEmail?: string;
    }
  }
}

const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

export interface AccessAuthConfig {
  /** When false the middleware is a passthrough (local dev, no edge in front). */
  enabled: boolean;
  /** The Access team issuer, e.g. https://myteam.cloudflareaccess.com */
  issuer?: string;
  /** The Access application AUD tag — pins the token to THIS app, not any other
   *  app in the same team. */
  audience?: string;
  /** Passed straight to jose. In production a cached remote JWKS; tests inject a
   *  local key so no network is touched. */
  keyResolver?: JWTVerifyGetKey | KeyLike | Uint8Array;
}

/**
 * Build the Access middleware from an explicit config. Exported so the test suite
 * can drive it with a locally-minted key instead of Cloudflare's live JWKS.
 */
export function makeAccessAuth(cfg: AccessAuthConfig) {
  return async function accessAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!cfg.enabled) {
      next();
      return;
    }

    const token = req.header(ACCESS_JWT_HEADER);
    if (!token) {
      res.status(401).json({
        error: 'Not signed in. Open this tool through the team access portal.',
        requestId: req.requestId,
      });
      return;
    }

    // Configured as enabled but with no way to verify: fail CLOSED, never open.
    if (!cfg.keyResolver) {
      res.status(500).json({
        error: 'Authentication is misconfigured on the server.',
        requestId: req.requestId,
      });
      return;
    }

    try {
      const { payload } = await jwtVerify(
        token,
        cfg.keyResolver as JWTVerifyGetKey,
        {
          issuer: cfg.issuer,
          audience: cfg.audience,
        },
      );

      const email = typeof payload.email === 'string' ? payload.email : undefined;
      if (!email) {
        // A valid Access token with no identity is not something we can attribute,
        // and every action in this tool is attributable by design. Refuse it.
        res.status(403).json({
          error: 'Signed in, but the session carried no identity. Sign in again.',
          requestId: req.requestId,
        });
        return;
      }

      req.accessEmail = email;
      next();
    } catch {
      // Deliberately no detail to the caller: expired, wrong aud, bad signature,
      // and forged all collapse to "sign in again". The stack is in the logs via
      // the correlation id if we ever need it.
      res.status(401).json({
        error: 'Your session is not valid. Sign in again.',
        requestId: req.requestId,
      });
    }
  };
}

/** Config derived from the environment. */
export function accessConfigFromEnv(): AccessAuthConfig {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = process.env.CF_ACCESS_AUD?.trim();

  if (!teamDomain || !audience) {
    return { enabled: false };
  }

  // Accept either a bare host (myteam.cloudflareaccess.com) or a full URL.
  const base = /^https?:\/\//.test(teamDomain)
    ? teamDomain.replace(/\/+$/, '')
    : `https://${teamDomain}`;

  return {
    enabled: true,
    issuer: base,
    audience,
    // createRemoteJWKSet caches keys in memory and refetches only on rotation, so
    // this is built ONCE at module load, not per request.
    keyResolver: createRemoteJWKSet(new URL(`${base}/cdn-cgi/access/certs`)),
  };
}

/** True when Cloudflare Access is configured. index.ts uses this to fail-closed
 *  in production and to log the auth posture at boot. */
export const accessAuthEnabled = Boolean(
  process.env.CF_ACCESS_TEAM_DOMAIN?.trim() && process.env.CF_ACCESS_AUD?.trim(),
);

/** The middleware the app mounts. */
export const accessAuth = makeAccessAuth(accessConfigFromEnv());
