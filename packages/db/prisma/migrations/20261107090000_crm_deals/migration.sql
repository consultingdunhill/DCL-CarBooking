-- A signed management contract counts as a closure.
ALTER TYPE "DealType" ADD VALUE 'MANAGEMENT';

-- The nightly CRM deals sync makes review batches with no uploader.
ALTER TABLE "ClosureImportBatch" ALTER COLUMN "uploadedById" DROP NOT NULL;
ALTER TABLE "ClosureImportBatch" DROP CONSTRAINT "ClosureImportBatch_uploadedById_fkey";
ALTER TABLE "ClosureImportBatch" ADD CONSTRAINT "ClosureImportBatch_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Each CRM deal waits in the review queue at most once.
ALTER TABLE "ClosureImportRow" ADD COLUMN "crmDealRef" TEXT;
CREATE UNIQUE INDEX "ClosureImportRow_crmDealRef_key" ON "ClosureImportRow"("crmDealRef");
