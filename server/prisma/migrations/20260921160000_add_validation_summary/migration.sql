-- Validation Results summary (2026-09-21). Additive only: one nullable JSON
-- column holding what became of every row (ready / fixed / blocked / removed,
-- plus duplicate diagnostics).
--
-- JSON rather than a dozen counter columns because these are display figures
-- that will keep changing shape, and nothing queries or aggregates them.
-- Existing runs keep NULL, meaning "validated before the summary existed" — the
-- UI shows the plain Total/Errors pair for those rather than inventing numbers.

-- AlterTable
ALTER TABLE "validation_runs" ADD COLUMN     "summary" JSONB;
