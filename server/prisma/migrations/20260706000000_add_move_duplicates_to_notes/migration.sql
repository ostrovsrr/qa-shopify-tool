-- Add ValidationRun.moveDuplicatesToNotes (report option: strip duplicated
-- email/phone from 2nd+ duplicate-group rows and append them to Note)
ALTER TABLE "validation_runs" ADD COLUMN "moveDuplicatesToNotes" BOOLEAN NOT NULL DEFAULT false;
