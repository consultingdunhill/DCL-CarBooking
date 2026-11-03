-- CreateEnum
CREATE TYPE "LocationSource" AS ENUM ('PHONE', 'TRACKER');

-- AlterTable
ALTER TABLE "Car" ADD COLUMN     "trackerDeviceId" TEXT;

-- AlterTable
ALTER TABLE "LocationPoint" ADD COLUMN     "source" "LocationSource" NOT NULL DEFAULT 'PHONE';

-- CreateIndex
CREATE UNIQUE INDEX "Car_trackerDeviceId_key" ON "Car"("trackerDeviceId");
