-- AlterTable
ALTER TABLE "validation_runs" ADD COLUMN     "originalColumns" JSONB;

-- CreateTable
CREATE TABLE "original_customer_rows" (
    "id" TEXT NOT NULL,
    "validationRunId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "original_customer_rows_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "original_customer_rows" ADD CONSTRAINT "original_customer_rows_validationRunId_fkey" FOREIGN KEY ("validationRunId") REFERENCES "validation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
