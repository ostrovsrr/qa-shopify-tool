/*
  Warnings:

  - Added the required column `updatedAt` to the `validation_runs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "validation_runs" ADD COLUMN     "comments" TEXT,
ADD COLUMN     "ticketName" TEXT,
ADD COLUMN     "ticketNumber" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;
