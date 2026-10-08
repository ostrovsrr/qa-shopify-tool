-- Index the run foreign key on the two customer child tables (2026-10-05).
-- Additive only: two CREATE INDEX statements, nothing dropped or altered.
--
-- original_customer_rows and validation_issues are read, and cascade-deleted, by
-- validationRunId, but had no index on it — every report, history delete and
-- retention purge scanned the whole table. The product twins
-- (product_original_rows, product_validation_issues) have had the equivalent
-- index from the start.
--
-- Generated with `prisma migrate diff` against a throwaway database at the
-- previous migration, so it does not touch the live DB's intentional drift
-- (validation_runs.crossReferenceData).
--
-- Plain CREATE INDEX (Prisma runs each migration in a transaction, which rules out
-- CONCURRENTLY): it blocks writes to these two tables while it builds. Run the
-- deploy when no validation is being persisted.

-- CreateIndex
CREATE INDEX "original_customer_rows_validationRunId_idx" ON "original_customer_rows"("validationRunId");

-- CreateIndex
CREATE INDEX "validation_issues_validationRunId_idx" ON "validation_issues"("validationRunId");
