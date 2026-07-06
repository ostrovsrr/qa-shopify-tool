-- Add ValidationRun.mergeMatchingDuplicates (report option: merge duplicate
-- rows whose names also match into one customer row in the Shopify Template)
ALTER TABLE "validation_runs" ADD COLUMN "mergeMatchingDuplicates" BOOLEAN NOT NULL DEFAULT false;
