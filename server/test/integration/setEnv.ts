// Runs (via setupFiles) before any test module — and therefore before the
// Prisma client is constructed — so Prisma connects to the throwaway test DB
// instead of the developer's real DATABASE_URL. Guarded: if TEST_DATABASE_URL
// is unset we leave DATABASE_URL alone and the suite skips itself.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
