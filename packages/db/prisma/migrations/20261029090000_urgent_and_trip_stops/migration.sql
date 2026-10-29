-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TrackingEventType" ADD VALUE 'STOP_ADDED';
ALTER TYPE "TrackingEventType" ADD VALUE 'STOP_CHANGED';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "createdById" UUID,
ADD COLUMN     "urgent" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

