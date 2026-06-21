-- AlterTable
-- Async import state: storeId lets a later reconcile rebuild the Shopify client,
-- error carries the reason for terminal failure states, and new runs default to RUNNING.
ALTER TABLE "import_runs" ADD COLUMN     "error" TEXT,
ADD COLUMN     "storeId" TEXT,
ALTER COLUMN "status" SET DEFAULT 'RUNNING';
