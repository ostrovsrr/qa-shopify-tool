-- CreateTable
CREATE TABLE "cleanup_runs" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "storeId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "importRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "bulkOperationId" TEXT,
    "error" TEXT,
    "found" INTEGER NOT NULL DEFAULT 0,
    "deleted" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "submittedIds" JSONB,
    "pollAttempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cleanup_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cleanup_runs_importRunId_idx" ON "cleanup_runs"("importRunId");

-- CreateIndex
CREATE INDEX "cleanup_runs_status_idx" ON "cleanup_runs"("status");
