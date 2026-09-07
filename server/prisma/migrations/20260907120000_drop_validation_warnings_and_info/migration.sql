-- Warning- and Info-severity pre-validation was removed: no rule emitted Info at
-- all, and the Warning checks flagged things Shopify imports without complaint.
-- These two aggregate columns counted issues that no longer exist.
--
-- Existing Warning rows in validation_issues are deliberately left in place —
-- dropping them would rewrite the historical record of what past runs reported.
-- The read paths filter to severity = 'Error', so old runs render like new ones.

-- AlterTable
ALTER TABLE "validation_runs"
  DROP COLUMN "warnings",
  DROP COLUMN "info";
