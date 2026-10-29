-- AlterTable
ALTER TABLE "BookingStop" ADD COLUMN     "crmLeadName" TEXT,
ADD COLUMN     "crmLeadRef" TEXT;

-- CreateIndex
CREATE INDEX "BookingStop_crmLeadRef_idx" ON "BookingStop"("crmLeadRef");
