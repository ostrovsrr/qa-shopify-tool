-- CreateTable
CREATE TABLE "validation_runs" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "totalRows" INTEGER NOT NULL,
    "errors" INTEGER NOT NULL,
    "warnings" INTEGER NOT NULL,
    "info" INTEGER NOT NULL,
    "affectedRows" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validation_issues" (
    "id" TEXT NOT NULL,
    "validationRunId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "columnName" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "issueType" TEXT NOT NULL,
    "currentValue" TEXT,
    "message" TEXT NOT NULL,
    "suggestedFix" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_issues_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "validation_issues" ADD CONSTRAINT "validation_issues_validationRunId_fkey" FOREIGN KEY ("validationRunId") REFERENCES "validation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
