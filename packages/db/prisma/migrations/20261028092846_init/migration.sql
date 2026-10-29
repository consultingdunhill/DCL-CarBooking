-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STAFF', 'ADMIN');

-- CreateEnum
CREATE TYPE "Department" AS ENUM ('SALES', 'LETTINGS', 'PROPERTY_MANAGEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "CarStatus" AS ENUM ('AVAILABLE', 'MAINTENANCE', 'RETIRED');

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'IN_PROGRESS', 'COMPLETED', 'AWAITING_ODOMETER', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "StopStatus" AS ENUM ('PROPOSED', 'PLANNED', 'ARRIVED', 'DEPARTED', 'SKIPPED', 'REJECTED');

-- CreateEnum
CREATE TYPE "JoinRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrackingStatus" AS ENUM ('NOT_STARTED', 'LIVE', 'OFFLINE', 'LOCATION_OFF', 'TRACKING_LOST', 'STOPPED');

-- CreateEnum
CREATE TYPE "TripEndMethod" AS ENUM ('MANUAL', 'GEOFENCE', 'ADMIN');

-- CreateEnum
CREATE TYPE "TrackingEventType" AS ENUM ('TRIP_STARTED', 'TRIP_ENDED', 'LOCATION_OFF', 'LOCATION_ON', 'PERMISSION_CHANGED', 'OFFLINE', 'ONLINE', 'AIRPLANE_MODE_ON', 'AIRPLANE_MODE_OFF', 'HEARTBEAT_MISSED', 'TRACKING_LOST', 'TRACKING_RESUMED', 'GEOFENCE_ENTER', 'GEOFENCE_EXIT', 'OFFICE_ARRIVED', 'STOP_ARRIVED', 'STOP_DEPARTED', 'OVERDUE', 'ETA_EXTENDED', 'LOW_BATTERY', 'AWAITING_ODOMETER');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('DEVICE', 'SERVER');

-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('VENDOR', 'LANDLORD', 'OTHER');

-- CreateEnum
CREATE TYPE "PropertyService" AS ENUM ('SALES', 'LETTINGS', 'MANAGEMENT');

-- CreateEnum
CREATE TYPE "PropertyStatus" AS ENUM ('ACTIVE', 'SOLD', 'LET', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DealType" AS ENUM ('SALE', 'LETTING');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('MATCHED', 'UNMATCHED', 'RESOLVED', 'IGNORED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "FuelEntryType" AS ENUM ('FILL_UP', 'MONTHLY');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'PUSH', 'EMAIL', 'SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PushKind" AS ENUM ('WEB', 'FCM');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "entraOid" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL DEFAULT 'STAFF',
    "department" "Department",
    "jobRoleId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "privacyAckAt" TIMESTAMPTZ(3),
    "privacyAckVersion" TEXT,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRole" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "JobRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HourlyRate" (
    "id" UUID NOT NULL,
    "jobRoleId" UUID,
    "forDriver" BOOLEAN NOT NULL DEFAULT false,
    "rate" DECIMAL(12,2) NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HourlyRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Office" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "arrivalRadiusM" INTEGER NOT NULL DEFAULT 20,
    "wakeupRadiusM" INTEGER NOT NULL DEFAULT 150,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Office_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Car" (
    "id" UUID NOT NULL,
    "registration" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "color" TEXT,
    "seats" INTEGER,
    "fuelType" "FuelType" NOT NULL,
    "status" "CarStatus" NOT NULL DEFAULT 'AVAILABLE',
    "homeOfficeId" UUID,
    "currentOdometer" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Car_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitReason" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "department" "Department" NOT NULL,
    "countsAsViewing" BOOLEAN NOT NULL DEFAULT false,
    "needsProperty" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ClientType" NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "crmRef" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "crmRef" TEXT,
    "address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "geog" geography(Point, 4326) GENERATED ALWAYS AS (CASE WHEN "lat" IS NOT NULL AND "lng" IS NOT NULL THEN ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)::geography END) STORED,
    "clientId" UUID,
    "service" "PropertyService" NOT NULL,
    "status" "PropertyStatus" NOT NULL DEFAULT 'ACTIVE',
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Closure" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "staffId" UUID,
    "closedAt" TIMESTAMPTZ(3) NOT NULL,
    "dealType" "DealType" NOT NULL,
    "fee" DECIMAL(14,2),
    "crmRef" TEXT,
    "importBatchId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Closure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClosureImportBatch" (
    "id" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "uploadedById" UUID NOT NULL,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowCount" INTEGER NOT NULL,
    "matchedCount" INTEGER NOT NULL,
    "unmatchedCount" INTEGER NOT NULL,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ClosureImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClosureImportRow" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "problems" TEXT[],
    "closureId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClosureImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "carId" UUID NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "expectedReturnAt" TIMESTAMPTZ(3) NOT NULL,
    "reasonId" UUID,
    "notes" TEXT,
    "plannedDistanceKm" DOUBLE PRECISION,
    "plannedDurationMin" INTEGER,
    "plannedPolyline" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "rejectionReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingStop" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "propertyId" UUID,
    "placeId" TEXT,
    "label" TEXT,
    "address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "addedById" UUID NOT NULL,
    "reasonId" UUID NOT NULL,
    "note" TEXT,
    "status" "StopStatus" NOT NULL DEFAULT 'PLANNED',
    "joinRequestId" UUID,
    "arrivedAt" TIMESTAMPTZ(3),
    "departedAt" TIMESTAMPTZ(3),
    "manualTimes" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingPassenger" (
    "bookingId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "joinRequestId" UUID,
    "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingPassenger_pkey" PRIMARY KEY ("bookingId","userId")
);

-- CreateTable
CREATE TABLE "JoinRequest" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "reasonId" UUID,
    "note" TEXT,
    "proposedReturnAt" TIMESTAMPTZ(3),
    "status" "JoinRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "odometerStart" INTEGER NOT NULL,
    "odometerEnd" INTEGER,
    "photoStartKey" TEXT NOT NULL,
    "photoEndKey" TEXT,
    "unloggedKm" INTEGER NOT NULL DEFAULT 0,
    "endMethod" "TripEndMethod",
    "endNote" TEXT,
    "gpsDistanceKm" DOUBLE PRECISION,
    "startRequestId" TEXT NOT NULL,
    "endRequestId" TEXT,
    "device" JSONB,
    "lastLat" DOUBLE PRECISION,
    "lastLng" DOUBLE PRECISION,
    "lastAccuracy" DOUBLE PRECISION,
    "lastSeenAt" TIMESTAMPTZ(3),
    "lastBattery" INTEGER,
    "lastAddress" TEXT,
    "lastContactAt" TIMESTAMPTZ(3),
    "locationOffSince" TIMESTAMPTZ(3),
    "trackingStatus" "TrackingStatus" NOT NULL DEFAULT 'LIVE',
    "trackingStatusSince" TIMESTAMPTZ(3),
    "officeArrivedAt" TIMESTAMPTZ(3),
    "overdueNotifiedAt" TIMESTAMPTZ(3),
    "awaitingOdometerAt" TIMESTAMPTZ(3),
    "lastReminderAt" TIMESTAMPTZ(3),
    "trackingTokenVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationPoint" (
    "id" BIGSERIAL NOT NULL,
    "tripId" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "geog" geography(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)::geography) STORED,
    "accuracy" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "altitude" DOUBLE PRECISION,
    "battery" INTEGER,
    "isCharging" BOOLEAN,
    "isMoving" BOOLEAN,
    "activity" TEXT,
    "event" TEXT,
    "uuid" TEXT,

    CONSTRAINT "LocationPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingEvent" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "type" "TrackingEventType" NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "EventSource" NOT NULL,
    "details" JSONB,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "clientEventId" TEXT,

    CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelEntry" (
    "id" UUID NOT NULL,
    "carId" UUID NOT NULL,
    "type" "FuelEntryType" NOT NULL DEFAULT 'FILL_UP',
    "date" TIMESTAMPTZ(3) NOT NULL,
    "litres" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "odometer" INTEGER,
    "receiptKey" TEXT,
    "notes" TEXT,
    "enteredById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FuelEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "payload" JSONB,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "readAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "PushKind" NOT NULL,
    "endpoint" TEXT NOT NULL,
    "keys" JSONB,
    "platform" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_entraOid_key" ON "User"("entraOid");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "JobRole_name_key" ON "JobRole"("name");

-- CreateIndex
CREATE INDEX "HourlyRate_jobRoleId_effectiveFrom_idx" ON "HourlyRate"("jobRoleId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Car_registration_key" ON "Car"("registration");

-- CreateIndex
CREATE UNIQUE INDEX "Client_crmRef_key" ON "Client"("crmRef");

-- CreateIndex
CREATE UNIQUE INDEX "Property_ref_key" ON "Property"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "Property_crmRef_key" ON "Property"("crmRef");

-- CreateIndex
CREATE INDEX "Property_status_idx" ON "Property"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Closure_crmRef_key" ON "Closure"("crmRef");

-- CreateIndex
CREATE INDEX "Closure_closedAt_idx" ON "Closure"("closedAt");

-- CreateIndex
CREATE INDEX "ClosureImportRow_status_idx" ON "ClosureImportRow"("status");

-- CreateIndex
CREATE INDEX "Booking_status_startAt_idx" ON "Booking"("status", "startAt");

-- CreateIndex
CREATE INDEX "Booking_carId_startAt_idx" ON "Booking"("carId", "startAt");

-- CreateIndex
CREATE INDEX "Booking_driverId_startAt_idx" ON "Booking"("driverId", "startAt");

-- CreateIndex
CREATE INDEX "Booking_ownerId_startAt_idx" ON "Booking"("ownerId", "startAt");

-- CreateIndex
CREATE INDEX "BookingStop_bookingId_seq_idx" ON "BookingStop"("bookingId", "seq");

-- CreateIndex
CREATE INDEX "BookingStop_propertyId_idx" ON "BookingStop"("propertyId");

-- CreateIndex
CREATE INDEX "JoinRequest_status_idx" ON "JoinRequest"("status");

-- CreateIndex
CREATE INDEX "JoinRequest_bookingId_idx" ON "JoinRequest"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_bookingId_key" ON "Trip"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_startRequestId_key" ON "Trip"("startRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_endRequestId_key" ON "Trip"("endRequestId");

-- CreateIndex
CREATE INDEX "Trip_trackingStatus_idx" ON "Trip"("trackingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "LocationPoint_uuid_key" ON "LocationPoint"("uuid");

-- CreateIndex
CREATE INDEX "LocationPoint_tripId_recordedAt_idx" ON "LocationPoint"("tripId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingEvent_clientEventId_key" ON "TrackingEvent"("clientEventId");

-- CreateIndex
CREATE INDEX "TrackingEvent_tripId_occurredAt_idx" ON "TrackingEvent"("tripId", "occurredAt");

-- CreateIndex
CREATE INDEX "FuelEntry_carId_date_idx" ON "FuelEntry"("carId", "date");

-- CreateIndex
CREATE INDEX "Notification_userId_channel_createdAt_idx" ON "Notification"("userId", "channel", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_jobRoleId_fkey" FOREIGN KEY ("jobRoleId") REFERENCES "JobRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HourlyRate" ADD CONSTRAINT "HourlyRate_jobRoleId_fkey" FOREIGN KEY ("jobRoleId") REFERENCES "JobRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Car" ADD CONSTRAINT "Car_homeOfficeId_fkey" FOREIGN KEY ("homeOfficeId") REFERENCES "Office"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Closure" ADD CONSTRAINT "Closure_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Closure" ADD CONSTRAINT "Closure_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Closure" ADD CONSTRAINT "Closure_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ClosureImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClosureImportBatch" ADD CONSTRAINT "ClosureImportBatch_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClosureImportRow" ADD CONSTRAINT "ClosureImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ClosureImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClosureImportRow" ADD CONSTRAINT "ClosureImportRow_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "Closure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "VisitReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingStop" ADD CONSTRAINT "BookingStop_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingStop" ADD CONSTRAINT "BookingStop_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingStop" ADD CONSTRAINT "BookingStop_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingStop" ADD CONSTRAINT "BookingStop_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "VisitReason"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingStop" ADD CONSTRAINT "BookingStop_joinRequestId_fkey" FOREIGN KEY ("joinRequestId") REFERENCES "JoinRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPassenger" ADD CONSTRAINT "BookingPassenger_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPassenger" ADD CONSTRAINT "BookingPassenger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoinRequest" ADD CONSTRAINT "JoinRequest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoinRequest" ADD CONSTRAINT "JoinRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoinRequest" ADD CONSTRAINT "JoinRequest_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "VisitReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoinRequest" ADD CONSTRAINT "JoinRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationPoint" ADD CONSTRAINT "LocationPoint_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelEntry" ADD CONSTRAINT "FuelEntry_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelEntry" ADD CONSTRAINT "FuelEntry_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Hand-written: things Prisma can't express ────────────────────────────────

-- A booking must end after it starts.
ALTER TABLE "Booking" ADD CONSTRAINT "booking_return_after_start" CHECK ("expectedReturnAt" > "startAt");

-- No double booking. Approved and in-progress bookings hold their car and the
-- driver; the database rejects any overlap, even if two admins approve at once.
ALTER TABLE "Booking" ADD CONSTRAINT "booking_car_no_overlap"
  EXCLUDE USING gist ("carId" WITH =, tstzrange("startAt", "expectedReturnAt", '[)') WITH &&)
  WHERE ("status" IN ('APPROVED', 'IN_PROGRESS'));

ALTER TABLE "Booking" ADD CONSTRAINT "booking_driver_no_overlap"
  EXCLUDE USING gist ("driverId" WITH =, tstzrange("startAt", "expectedReturnAt", '[)') WITH &&)
  WHERE ("status" IN ('APPROVED', 'IN_PROGRESS'));
