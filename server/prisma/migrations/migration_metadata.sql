-- AlterTable: add editable metadata fields and updatedAt to validation_runs
ALTER TABLE "validation_runs"
  ADD COLUMN "ticketNumber" TEXT,
  ADD COLUMN "ticketName"   TEXT,
  ADD COLUMN "comments"     TEXT,
  ADD COLUMN "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
