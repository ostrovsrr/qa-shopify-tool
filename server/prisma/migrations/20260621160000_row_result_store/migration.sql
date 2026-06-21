-- Track which store imported each row so the report can break results down per
-- store in a parallel batch. Null for single/legacy rows.
ALTER TABLE "import_row_results" ADD COLUMN     "storeId" TEXT;
