import { recordedDistanceKm, type TrackerFix } from '@carbooking/core';
import { prisma } from '@carbooking/db';
import { getSettings } from './settings';
import { detectZonesAfterTrip, ingestLocations } from './tracking';
import { trackerToDeviceLocation } from './trackers';

const MINUTE = 60_000;

export interface TrackerImportTrip {
  tripId: string;
  bookingId: string;
  startedAt: Date;
  endedAt: Date | null;
  owner: string;
  added: number;
}

export interface TrackerImportResult {
  from: Date | null;
  to: Date | null;
  trips: TrackerImportTrip[];
  /** Fixes outside every trip of the car (parked, or a trip nobody booked). */
  outsideTrips: number;
}

/**
 * Attach a car's tracker history (an uploaded export) to the car's trips by
 * time, tagged as TRACKER. The tracker reports around the clock; only fixes
 * inside a trip are kept. Each fix's uuid comes from the car and its time, so
 * uploading the same file again adds nothing. An ended trip's GPS distance is
 * recomputed from the tracker path, which then drives the odometer check, and
 * its stop visits and return to the office are found on that path.
 */
export async function importTrackerHistory(car: { id: string; trackerDeviceId: string | null }, fixes: TrackerFix[], now = new Date()): Promise<TrackerImportResult> {
  if (fixes.length === 0) return { from: null, to: null, trips: [], outsideTrips: 0 };
  const from = fixes[0]!.recordedAt;
  const to = fixes[fixes.length - 1]!.recordedAt;
  const trips = await prisma.trip.findMany({
    where: {
      booking: { carId: car.id },
      startedAt: { lte: new Date(to.getTime() + MINUTE) },
      OR: [{ endedAt: null }, { endedAt: { gte: new Date(from.getTime() - MINUTE) } }],
    },
    orderBy: { startedAt: 'asc' },
    select: { id: true, bookingId: true, startedAt: true, endedAt: true, awaitingOdometerAt: true, booking: { select: { owner: { select: { name: true } } } } },
  });

  const deviceId = car.trackerDeviceId ?? `car-${car.id}`;
  const used = new Set<TrackerFix>();
  const out: TrackerImportTrip[] = [];
  for (const t of trips) {
    // The same window ingest keeps, so nothing here is dropped there.
    const start = t.startedAt.getTime() - MINUTE;
    const end = (t.endedAt ?? t.awaitingOdometerAt ?? now).getTime() + MINUTE;
    const mine = fixes.filter((f) => f.recordedAt.getTime() >= start && f.recordedAt.getTime() <= end);
    if (mine.length === 0) continue;
    mine.forEach((f) => used.add(f));

    const before = await prisma.locationPoint.count({ where: { tripId: t.id, source: 'TRACKER' } });
    const locations = mine.map((f) =>
      trackerToDeviceLocation({
        deviceId,
        recordedAt: f.recordedAt,
        lat: f.lat,
        lng: f.lng,
        speed: f.speedKmh != null ? f.speedKmh / 3.6 : null,
        heading: f.heading,
        altitude: null,
        ignition: f.ignition,
        battery: null,
      }),
    );
    await ingestLocations(t.id, locations, now, 'TRACKER');
    const added = (await prisma.locationPoint.count({ where: { tripId: t.id, source: 'TRACKER' } })) - before;

    if (added > 0 && t.endedAt) {
      const s = await getSettings();
      const path = await prisma.locationPoint.findMany({ where: { tripId: t.id, source: 'TRACKER' }, select: { lat: true, lng: true, recordedAt: true, accuracy: true } });
      await prisma.trip.update({ where: { id: t.id }, data: { gpsDistanceKm: recordedDistanceKm(path, { maxAccuracyM: s.maxFixAccuracyM }) } });
    }
    // A running trip already checks its stops as fixes arrive; an ended one gets them now.
    // Even with nothing new, so uploading again re-checks after the stop radius is changed.
    await detectZonesAfterTrip(t.id);
    out.push({ tripId: t.id, bookingId: t.bookingId, startedAt: t.startedAt, endedAt: t.endedAt, owner: t.booking.owner.name, added });
  }
  return { from, to, trips: out, outsideTrips: fixes.length - used.size };
}
