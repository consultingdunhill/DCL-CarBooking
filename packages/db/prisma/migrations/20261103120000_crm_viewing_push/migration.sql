-- CreateTable
CREATE TABLE "CrmViewingPush" (
    "bookingId" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "pushedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CrmViewingPush_pkey" PRIMARY KEY ("bookingId")
);

-- AddForeignKey
ALTER TABLE "CrmViewingPush" ADD CONSTRAINT "CrmViewingPush_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
