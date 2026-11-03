import { prisma } from '@carbooking/db';
import { ingestLocations } from './tracking';
import { getTrackerProvider, trackerEnabled, trackerToDeviceLocation } from './trackers';

/**
 * Pull hardware-tracker fixes for every running trip whose car has a tracker
 * fitted, and feed them into the trip's tracking pipeline tagged as TRACKER.
 *
 * The tracker reports 24/7; we only read and attribute its fixes while the trip
 * is IN_PROGRESS, which is what makes it "start when the ride starts". Ingest
 * dedupes by uuid and clamps to the trip window, so over-fetching is harmless.
 */
export async function runTrackerSync(now = new Date()) {
  if (!trackerEnabled()) return;
  const provider = getTrackerProvider();
  const trips = await prisma.trip.findMany({
    where: { booking: { status: 'IN_PROGRESS', car: { trackerDeviceId: { not: null } } } },
    select: {
      id: true,
      startedAt: true,
      lastSeenAt: true,
      booking: { select: { car: { select: { trackerDeviceId: true } } } },
    },
  });
  for (const t of trips) {
    const deviceId = t.booking.car.trackerDeviceId!;
    const since = t.lastSeenAt ?? t.startedAt;
    let positions;
    try {
      positions = await provider.fetchPositions([deviceId], since);
    } catch (err) {
      console.error(`[tracker-sync] ${provider.name} fetch failed for device ${deviceId}:`, (err as Error).message);
      continue;
    }
    const locations = positions.filter((p) => p.recordedAt.getTime() > since.getTime()).map(trackerToDeviceLocation);
    if (locations.length) await ingestLocations(t.id, locations, now, 'TRACKER');
  }
}
