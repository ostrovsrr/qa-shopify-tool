-- Resume intent marker (2026-09-12). Additive only: one nullable column per table
-- that can hold a PENDING row. Written just before bulkOperationRunMutation is
-- called, so resume can tell "never submitted" (safe to relaunch) from "submit
-- outcome unknown" (fail honestly) without asking the shop which op is ours.
-- Existing rows keep NULL.

-- AlterTable
ALTER TABLE "import_runs" ADD COLUMN     "submitAttemptedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "import_batch_jobs" ADD COLUMN     "submitAttemptedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "product_import_runs" ADD COLUMN     "submitAttemptedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "product_import_jobs" ADD COLUMN     "submitAttemptedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "cleanup_runs" ADD COLUMN     "submitAttemptedAt" TIMESTAMP(3);
