-- Batch parent runs have no bulk op of their own (it lives on each child job).
ALTER TABLE "import_runs" ALTER COLUMN "bulkOperationId" DROP NOT NULL;

-- CreateTable: one per-store bulk operation within a parallel batch import.
CREATE TABLE "import_batch_jobs" (
    "id" TEXT NOT NULL,
    "importRunId" TEXT NOT NULL,
    "storeId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "batchIndex" INTEGER NOT NULL,
    "batchCount" INTEGER NOT NULL,
    "bulkOperationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "error" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batch_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batch_jobs_importRunId_idx" ON "import_batch_jobs"("importRunId");

-- AddForeignKey
ALTER TABLE "import_batch_jobs" ADD CONSTRAINT "import_batch_jobs_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "import_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
