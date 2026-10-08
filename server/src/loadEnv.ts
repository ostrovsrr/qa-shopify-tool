import dotenv from 'dotenv';

// ─────────────────────────────────────────────────────────────────────────────
// LOAD server/.env BEFORE ANYTHING READS process.env.
//
// This must be the FIRST import in index.ts. index.ts used to call dotenv.config()
// after all its imports, but several modules read the environment at load time:
//   - db/prisma.ts builds the datasource URL (DATABASE_CONNECTION_LIMIT, pool) when
//     the client is constructed,
//   - services/retention.service.ts reads RETENTION_DAYS,
//   - services/uploadFile.ts reads UPLOAD_DIR.
// So with `npm run dev` / a local `npm run start`, those .env settings were
// silently ignored (or picked up only by accident, via Prisma's own .env loading).
//
// Production is deliberately left alone. Every hosted instance (the Docker image,
// the native Windows launcher) injects its environment into the process and sets
// NODE_ENV=production; there, index.ts keeps its original late dotenv.config() and
// nothing about what gets loaded, or when, changes. In particular a stray
// server/.env on a host cannot start feeding RETENTION_DAYS into a process whose
// launcher deliberately unset it.
// ─────────────────────────────────────────────────────────────────────────────

export function shouldLoadDotEnvEarly(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== 'production';
}

if (shouldLoadDotEnvEarly(process.env)) {
  dotenv.config();
}
