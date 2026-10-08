import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { shouldLoadDotEnvEarly } from '../src/loadEnv';

// ─────────────────────────────────────────────────────────────────────────────
// server/.env must be loaded BEFORE the modules that read process.env at load time
// (db/prisma.ts → DATABASE_CONNECTION_LIMIT, retention → RETENTION_DAYS, uploads →
// UPLOAD_DIR). index.ts used to call dotenv.config() after all its imports, so in
// dev those settings were silently ignored. Production (NODE_ENV=production,
// environment injected by the launcher) keeps its original behaviour.
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_DIR = path.resolve(__dirname, '..');
const LOAD_ENV = path.join(SERVER_DIR, 'src', 'loadEnv.ts');

/** Run loadEnv in a fresh process whose cwd holds a .env with a FAKE probe value. */
function probeInChild(nodeEnv: string | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-loadenv-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'QA_LOADENV_PROBE=from-dotenv\n');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TS_NODE_PROJECT: path.join(SERVER_DIR, 'tsconfig.json'),
      TS_NODE_TRANSPILE_ONLY: '1',
    };
    delete env.QA_LOADENV_PROBE;
    if (nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = nodeEnv;

    return execFileSync(
      process.execPath,
      [
        '-r',
        require.resolve('ts-node/register', { paths: [SERVER_DIR] }),
        '-e',
        `require(${JSON.stringify(LOAD_ENV)}); process.stdout.write(process.env.QA_LOADENV_PROBE || '<unset>')`,
      ],
      { cwd: dir, env, encoding: 'utf8' },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('early .env loading', () => {
  it('is the very first import of index.ts', () => {
    const source = fs.readFileSync(path.join(SERVER_DIR, 'src', 'index.ts'), 'utf8');
    const firstImport = source.split(/\r?\n/).find((line) => /^import\b/.test(line));
    expect(firstImport).toBe("import './loadEnv';");
  });

  it('loads .env in dev, where NODE_ENV is unset', () => {
    expect(shouldLoadDotEnvEarly({})).toBe(true);
    expect(probeInChild(undefined)).toBe('from-dotenv');
  }, 30_000);

  it('leaves production alone: the launcher injects its environment', () => {
    expect(shouldLoadDotEnvEarly({ NODE_ENV: 'production' })).toBe(false);
    expect(probeInChild('production')).toBe('<unset>');
  }, 30_000);
});
