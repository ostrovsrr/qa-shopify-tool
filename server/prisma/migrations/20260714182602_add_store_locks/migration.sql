-- CreateTable
CREATE TABLE "store_locks" (
    "store_id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_locks_pkey" PRIMARY KEY ("store_id")
);

-- CreateIndex
CREATE INDEX "store_locks_owner_id_idx" ON "store_locks"("owner_id");
