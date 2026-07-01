import { configDefaults, defineConfig } from 'vitest/config';

// Default project: fast, dependency-free unit tests (validators + parser).
// Integration tests live under test/integration and are excluded here so
// `npm test` never needs a database. Run those with `npm run test:integration`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    globals: false,
  },
});
