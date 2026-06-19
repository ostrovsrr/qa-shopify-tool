-- CreateTable
CREATE TABLE "import_runs" (
    "id" TEXT NOT NULL,
    "validationId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "bulkOperationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row_results" (
    "id" TEXT NOT NULL,
    "importRunId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "shopifyCustomerId" TEXT,
    "shopifyCode" TEXT,
    "shopifyField" TEXT,
    "message" TEXT,
    "wasFlaggedByValidator" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_row_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_runs_validationId_idx" ON "import_runs"("validationId");

-- CreateIndex
CREATE INDEX "import_row_results_importRunId_idx" ON "import_row_results"("importRunId");

-- CreateIndex
CREATE INDEX "import_row_results_accepted_wasFlaggedByValidator_idx" ON "import_row_results"("accepted", "wasFlaggedByValidator");

-- AddForeignKey
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_validationId_fkey" FOREIGN KEY ("validationId") REFERENCES "validation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row_results" ADD CONSTRAINT "import_row_results_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "import_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
