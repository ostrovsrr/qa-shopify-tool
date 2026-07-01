import { defineConfig } from 'vitest/config';

// Integration project: exercises the Express app against a real PostgreSQL.
// Requires TEST_DATABASE_URL to point at a THROWAWAY database (the suite
// truncates tables between tests). If it is unset the tests skip themselves.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['test/integration/setEnv.ts'],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // DB state is shared, so don't run integration files in parallel.
    fileParallelism: false,
  },
});
