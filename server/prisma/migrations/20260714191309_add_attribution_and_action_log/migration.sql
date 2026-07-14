-- AlterTable
ALTER TABLE "product_upload_runs" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "piiPurgedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "validation_runs" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "piiPurgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "action_log" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "storeId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "action_log_createdAt_idx" ON "action_log"("createdAt");

-- CreateIndex
CREATE INDEX "action_log_storeId_idx" ON "action_log"("storeId");
