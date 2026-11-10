-- A trip that recorded fewer than two GPS fixes has no GPS distance, not 0 km.
-- Stored as 0, it showed as a 100% odometer-vs-GPS mismatch.
UPDATE "Trip" t
SET "gpsDistanceKm" = NULL
WHERE t."gpsDistanceKm" = 0
  AND (SELECT count(*) FROM "LocationPoint" lp WHERE lp."tripId" = t.id) < 2;
