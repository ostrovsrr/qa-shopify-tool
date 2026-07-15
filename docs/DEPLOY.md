# Deploying the QA tool

One container: Express serves the API and the built React app from one origin. One
PostgreSQL database.

---

## ⚠ AUTHENTICATION — CLOUDFLARE ACCESS IS REQUIRED IN PRODUCTION

The app has no login of its own. It relies on **Cloudflare Access** sitting in front
of it: Access authenticates the person at the edge (Google / email OTP) and injects a
signed JWT on every request, which the server verifies (`middleware/accessAuth.ts`).
Identity — who uploaded a run, who fired a cleanup — comes from that verified JWT, not
from the spoofable `X-QA-User` header.

**In production this is mandatory and enforced by a fail-closed boot check.** With
`NODE_ENV=production` and Access not configured, the server **refuses to start** rather
than serve every route unauthenticated. You cannot forget to turn auth on.

Why the tool would be dangerous without it: anyone who reached it could upload a CSV,
import into your Shopify test stores, and fire the cleanup routes that delete records
**by tag across an entire store**.

### Setting it up

1. Put the container behind a **Cloudflare Tunnel** (or any origin Cloudflare fronts).
2. Create a **Cloudflare Access application** covering the tool's hostname, with a
   policy that allows your ~5 colleagues (an email list or your Google Workspace).
3. From that Access application, copy its **Application Audience (AUD) tag**.
4. Set two variables on the container:

   ```bash
   CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com   # your Access team domain
   CF_ACCESS_AUD=<the Application AUD tag>                # pins tokens to THIS app
   ```

The server fetches Cloudflare's public keys from
`https://<team>/cdn-cgi/access/certs` (cached, auto-refreshed on rotation) and verifies
the token's signature, `aud`, `iss`, and expiry on every request. `GET /api/health`
is deliberately exempt so the platform's liveness probe works without a token.

**Local dev needs none of this.** With the two variables unset the auth middleware is a
passthrough and identity falls back to the `X-QA-User` label — fine, because the only
person reaching localhost is you. The boot log says which posture is active.

---

## What the container needs

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres. Pool settings are added automatically (`connection_limit=10`, `pool_timeout=30`); an explicit value in the URL wins. |
| `SHOPIFY_TEST_STORES` | yes | JSON array of stores. See `config/shopify.ts`. |
| `PORT` | no | Defaults to 3001. |
| `NODE_ENV` | yes | Must be `production` for the server to serve the client. Also makes Access mandatory: the server refuses to boot without it. |
| `CF_ACCESS_TEAM_DOMAIN` | yes (prod) | Your Cloudflare Access team domain, e.g. `yourteam.cloudflareaccess.com`. Bare host or full URL. |
| `CF_ACCESS_AUD` | yes (prod) | The Access **application** AUD tag. Pins tokens to this app, not any other app in the same team. |
| `UPLOAD_DIR` | no | Defaults to `/tmp/qa-uploads` in the image. |
| `RETENTION_DAYS` | no | Days raw uploaded rows are kept. Default 30. `0` disables the purge. |
| `DATABASE_CONNECTION_LIMIT` | no | Default 10. Lower it if your Postgres has a small `max_connections`. |

## Build and run

```bash
docker build -t qa-shopify-tool .
docker run -p 3001:3001 --env-file server/.env -e NODE_ENV=production qa-shopify-tool
```

Migrations run at **start**, not at build (the database is not reachable from the
build). The image runs `prisma migrate deploy`, which applies pending migrations and
**cannot** reset or drop anything.

> **Never run `prisma migrate dev` against a real database here.** Its drift check can
> offer a destructive reset, and this database has *intentional* drift
> (`validation_runs.crossReferenceData` exists in the DB but not in `schema.prisma`).

## Health probe

Point the platform at **`GET /api/health`**.

It checks the process and the database. It deliberately does **not** touch Shopify: a
health check that calls a third-party API means an outage at Shopify — or one expired
token — makes the platform conclude *our* container is unhealthy and kill it, taking
every in-flight import with it.

## Sizing

- **Memory.** Uploads stream to disk, so the raw file is not in the heap. But parsing
  still builds one JS object per row (a 5-10x blowup over the file), and that is what
  dominates for a large CSV. 512 MB is workable for the CSVs seen so far; a
  100 MB upload will need more. See `TODOS.md` #2.
- **CPU.** Node runs one event loop and validation is synchronous. While one colleague
  validates a large CSV, everyone else's status polls wait behind it. Also `TODOS.md` #2.
- **Disk.** Ephemeral is correct. Uploads land in `UPLOAD_DIR` and are deleted as soon
  as they are consumed; orphans are swept hourly. Nothing else is written to disk.

## Data retention — OFF by default, and it will not surprise you

`RETENTION_DAYS` purges the raw uploaded rows of old runs. The aggregate QA results
survive; the personal data does not. A run whose import is still in flight is never
purged, however old.

**It is OFF unless you set it.** It used to default to 30 days, and on 2026-07-14 a
routine server restart silently and irreversibly deleted the raw rows of 47 real
validation runs — because nobody had set a variable they did not know existed. An
irreversible sweep must never run because someone *forgot* something.

So there are two switches, on purpose:

```bash
RETENTION_DAYS=30       # the policy: how long rows live
RETENTION_CONFIRMED=1   # "yes, I accept what that deletes from THIS database, now"
```

With `RETENTION_DAYS` set but `RETENTION_CONFIRMED` unset, the first sweep that would
destroy anything **refuses**, and logs exactly how many existing runs it was about to
gut. Read that number, then decide. Deciding the policy and accepting what it does to
the data already in front of you are two different decisions.

**This is theatre unless it is aligned with the database's backup window.** A 30-day
purge on a database with 35-day point-in-time recovery deletes nothing meaningful: the
data is still restorable, for longer than the policy claims. Set the platform's PITR /
backup retention to **no longer than** `RETENTION_DAYS`, or raise `RETENTION_DAYS` to
match it. Whoever configures the database is the one who makes this true.

## Region

The CSVs contain EU/UK merchant customer data. Put the database and the container in a
region consistent with where that data is allowed to live, and decide this **before**
the first real upload — moving a database full of PII after the fact is a migration
nobody wants.

## What is deliberately not here

- **A user store / passwords / sessions.** Authentication is delegated entirely to
  Cloudflare Access (see the top). The app never sees a password and holds no session —
  it trusts a verified per-request JWT. Removing an Access user removes their access
  immediately, with nothing to clean up here.
- **Backups of the app database.** Retention says how long PII lives; backups will keep
  it longer unless you align them (above).
- **Horizontal scaling.** The store busy-lock and the resume lease are both in Postgres,
  so a second container would be *correct*, but nothing has been tested that way.
