-- Add ValidationRun.subaddressDuplicateEmails (cleanup option: give each 2nd+
-- duplicate-email row a unique name+dupN@domain sub-address, original kept in Note)
ALTER TABLE "validation_runs" ADD COLUMN "subaddressDuplicateEmails" BOOLEAN NOT NULL DEFAULT false;
