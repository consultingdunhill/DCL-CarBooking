-- What was last sent to ERPNext for each Fleet record (packages/server/src/erp/sync.ts).
-- CreateTable
CREATE TABLE "ErpSyncState" (
    "id" UUID NOT NULL,
    "doctype" TEXT NOT NULL,
    "fleetId" TEXT NOT NULL,
    "erpName" TEXT NOT NULL,
    "payloadHash" TEXT,
    "syncedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "failedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ErpSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ErpSyncState_doctype_fleetId_key" ON "ErpSyncState"("doctype", "fleetId");
