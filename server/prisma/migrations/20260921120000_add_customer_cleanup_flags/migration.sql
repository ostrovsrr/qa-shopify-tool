-- Cleanup options on the mapping screen (2026-09-21). Additive only: two boolean
-- columns on validation_runs, both defaulting to FALSE so every existing run
-- replays exactly as it did before. That default is load-bearing — the import and
-- the Excel report rebuild their dataset from these flags, so a run validated
-- before this migration must keep producing the same rows.
--
--   moveInvalidContactToNotes — clear an Email/Phone Shopify would reject into
--     Note, so the rest of the row still imports.
--   fillMissingContactName — give a row that carries real data but no
--     name/email/phone a placeholder First Name so Shopify accepts it. Blank
--     rows are never named.

-- AlterTable
ALTER TABLE "validation_runs" ADD COLUMN     "moveInvalidContactToNotes" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "validation_runs" ADD COLUMN     "fillMissingContactName" BOOLEAN NOT NULL DEFAULT false;
