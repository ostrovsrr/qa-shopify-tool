// ─────────────────────────────────────────────────────────────────────────────
// Container entry wrapper: build DATABASE_URL from POSTGRES_PASSWORD, then run the
// given command.
//
//   node /app/with-db-url.js <command> [args...]
//
// Why this exists: docker-compose.yml used to interpolate the raw password into
// postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/...  and
// deploy/.env.example told you to generate it with `openssl rand -base64 32`, whose
// output contains `/`, `+` and `=`. A `/` ends the authority section of a URL, so
// that password broke URL parsing for `migrate` and every SE. Compose cannot
// percent-encode, so the encoding happens here, at container start, for ANY
// password -- the same thing the Windows scripts do with [uri]::EscapeDataString.
//
// A password that is already URL-safe encodes to itself, so existing installs get
// byte-for-byte the URL they had before.
//
// If DATABASE_URL is already set (non-empty), it is used as is: that is the
// single-container `docker run -e DATABASE_URL=...` path.
//
// No dependencies: plain Node built-ins, like deploy/monitor/monitor.js.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { spawn } = require('child_process');

const env = { ...process.env };

if (!env.DATABASE_URL) {
  const password = env.POSTGRES_PASSWORD;
  if (!password) {
    console.error('with-db-url: neither DATABASE_URL nor POSTGRES_PASSWORD is set');
    process.exit(64);
  }
  const user = env.POSTGRES_USER || 'postgres';
  const host = env.POSTGRES_HOST || 'postgres';
  const port = env.POSTGRES_PORT || '5432';
  const db = env.POSTGRES_DB || 'shopify_csv_qa';
  env.DATABASE_URL =
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${encodeURIComponent(db)}`;
}

// The app and the Prisma CLI only need the URL. Do not hand the bare password to
// a process that has no use for it.
delete env.POSTGRES_PASSWORD;

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('with-db-url: no command given');
  process.exit(64);
}

const child = spawn(cmd, args, { env, stdio: 'inherit' });

// `docker stop` sends SIGTERM to PID 1 -- this process. Pass it on, so the app
// gets its graceful shutdown instead of a SIGKILL ten seconds later.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}

child.on('error', (err) => {
  console.error(`with-db-url: could not start ${cmd}: ${err.message}`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 128 + (require('os').constants.signals[signal] ?? 0) : 1));
});
