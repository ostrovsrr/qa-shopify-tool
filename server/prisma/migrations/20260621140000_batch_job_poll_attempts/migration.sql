-- Bound stuck batch jobs: count reconcile polls so a perma-RUNNING / repeatedly
-- erroring job can be failed after a max number of attempts.
ALTER TABLE "import_batch_jobs" ADD COLUMN     "pollAttempts" INTEGER NOT NULL DEFAULT 0;
