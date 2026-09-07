-- The validator-feedback loop is gone. This tool answers one question — will
-- Shopify accept this file? — and "was our pre-check right about this row?" is a
-- question for whoever maintains the validators, not for the person running a
-- migration. The four-bucket summary, the rule-gap backlog, the Rule Gaps and
-- false-positive report sheets, and the Pre-check report columns all went with it.
--
-- This column existed only to feed those. Nothing reads it any more, and the
-- index existed only for the rule-gap backlog query.

-- DropIndex
DROP INDEX IF EXISTS "import_row_results_accepted_wasFlaggedByValidator_idx";

-- AlterTable
ALTER TABLE "import_row_results" DROP COLUMN "wasFlaggedByValidator";
