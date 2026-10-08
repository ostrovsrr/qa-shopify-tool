-- Add cleanup_ops, the per-bulk-delete child of cleanup_runs (2026-10-08).
-- Additive only: one CREATE TABLE, two indexes and a foreign key; nothing dropped or altered.
--
-- A store's QA cleanup can now run as up to 5 concurrent Shopify bulk deletes, so
-- each delete needs its own row (bulk operation id, status, counts, refused ids).
-- cleanup_runs keeps the totals. No code writes to this table yet.
--
-- Generated with `prisma migrate diff` against a throwaway shadow database, so it
-- does not touch the live DB's intentional drift (validation_runs.crossReferenceData).

-- CreateTable
CREATE TABLE "cleanup_ops" (
    "id" TEXT NOT NULL,
    "cleanupRunId" TEXT NOT NULL,
    "opIndex" INTEGER NOT NULL,
    "opCount" INTEGER NOT NULL,
    "bulkOperationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "deleted" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "pollAttempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "submitAttemptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cleanup_ops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cleanup_ops_cleanupRunId_idx" ON "cleanup_ops"("cleanupRunId");

-- CreateIndex
CREATE INDEX "cleanup_ops_status_idx" ON "cleanup_ops"("status");

-- AddForeignKey
ALTER TABLE "cleanup_ops" ADD CONSTRAINT "cleanup_ops_cleanupRunId_fkey" FOREIGN KEY ("cleanupRunId") REFERENCES "cleanup_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
