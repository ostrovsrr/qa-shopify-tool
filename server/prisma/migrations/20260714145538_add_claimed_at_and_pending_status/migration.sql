-- AlterTable
ALTER TABLE "import_batch_jobs" ADD COLUMN     "claimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "import_runs" ADD COLUMN     "claimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "product_import_jobs" ADD COLUMN     "claimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "product_import_runs" ADD COLUMN     "claimedAt" TIMESTAMP(3);
