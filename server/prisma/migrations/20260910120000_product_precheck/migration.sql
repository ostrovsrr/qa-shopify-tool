-- Product pre-check (2026-09-10). Additive only: one nullable column and one new
-- table. Existing uploads keep precheckErrors = NULL, meaning "never checked".

-- AlterTable
ALTER TABLE "product_upload_runs" ADD COLUMN     "precheckErrors" INTEGER;

-- CreateTable
CREATE TABLE "product_validation_issues" (
    "id" TEXT NOT NULL,
    "uploadRunId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "handle" TEXT NOT NULL,
    "columnName" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "issueType" TEXT NOT NULL,
    "currentValue" TEXT,
    "message" TEXT NOT NULL,
    "suggestedFix" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_validation_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_validation_issues_uploadRunId_idx" ON "product_validation_issues"("uploadRunId");

-- AddForeignKey
ALTER TABLE "product_validation_issues" ADD CONSTRAINT "product_validation_issues_uploadRunId_fkey" FOREIGN KEY ("uploadRunId") REFERENCES "product_upload_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
