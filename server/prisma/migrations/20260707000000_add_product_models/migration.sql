-- CreateTable
CREATE TABLE "product_upload_runs" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "productCount" INTEGER NOT NULL,
    "originalColumns" JSONB,
    "ticketNumber" TEXT,
    "ticketName" TEXT,
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_upload_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_import_runs" (
    "id" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "storeId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "bulkOperationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "error" TEXT,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_import_jobs" (
    "id" TEXT NOT NULL,
    "importRunId" TEXT NOT NULL,
    "storeId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "batchIndex" INTEGER NOT NULL,
    "batchCount" INTEGER NOT NULL,
    "bulkOperationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "error" TEXT,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "pollAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_import_results" (
    "id" TEXT NOT NULL,
    "importRunId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "shopifyProductId" TEXT,
    "shopifyCode" TEXT,
    "shopifyField" TEXT,
    "message" TEXT,
    "storeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_import_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_original_rows" (
    "id" TEXT NOT NULL,
    "uploadRunId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_original_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_import_runs_uploadId_idx" ON "product_import_runs"("uploadId");

-- CreateIndex
CREATE INDEX "product_import_jobs_importRunId_idx" ON "product_import_jobs"("importRunId");

-- CreateIndex
CREATE INDEX "product_import_results_importRunId_idx" ON "product_import_results"("importRunId");

-- CreateIndex
CREATE INDEX "product_original_rows_uploadRunId_idx" ON "product_original_rows"("uploadRunId");

-- AddForeignKey
ALTER TABLE "product_import_runs" ADD CONSTRAINT "product_import_runs_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "product_upload_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_import_jobs" ADD CONSTRAINT "product_import_jobs_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "product_import_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_import_results" ADD CONSTRAINT "product_import_results_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "product_import_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_original_rows" ADD CONSTRAINT "product_original_rows_uploadRunId_fkey" FOREIGN KEY ("uploadRunId") REFERENCES "product_upload_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
