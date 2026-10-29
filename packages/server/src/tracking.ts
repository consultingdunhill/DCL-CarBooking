import {
  deriveTrackingStatus,
  detectOfficeArrival,
  detectStopVisits,
  fmtTime,
  shortName,
  statusChangeEvent,
  type DeviceLocation,
  type Settings,
  type TrackingEventType,
  type TrackingStatus,
} from '@carbooking/core';
import { prisma, type Prisma } from '@carbooking/db';
import { describeLocation } from './geocode';
import { publishLive } from './live';
import { notify } from './notify';
import { getSettings } from './settings';

const tripInclude = {
  booking: {
    include: {
      owner: { select: { id: true, name: true } },
      car: { select: { id: true, registration: true, homeOffice: true } },
      stops: { where: { status: { in: ['PLANNED', 'ARRIVED', 'DEPARTED'] } }, orderBy: { seq: 'asc' } },
    },
  },
} satisfies Prisma.TripInclude;
type TripWithBooking = Prisma.TripGetPayload<{ include: typeof tripInclude }>;

const MINUTE = 60_000;

/** Battery from the plugin is 0–1 (or -1 when unknown); store as 0–100. */
function batteryPct(level: number | undefined): number | null {
  if (level == null || level < 0) return null;
  return Math.round(level <= 1 ? level * 100 : level);
}

async function loadTrip(tripId: string) {
  return prisma.trip.findUnique({ where: { id: tripId }, include: tripInclude });
}

async function office(trip: TripWithBooking) {
  return trip.booking.car.homeOffice ?? (await prisma.office.findFirst({ orderBy: { createdAt: 'asc' } }));
}

function who(trip: TripWithBooking) {
  return `${shortName(trip.booking.owner.name)} (${trip.booking.car.registration})`;
}

async function liveUpdate(tripId: string) {
  const t = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { id: true, bookingId: true, trackingStatus: true, lastLat: true, lastLng: true, lastSeenAt: true, lastBattery: true },
  });
  if (!t) return;
  await publishLive({
    type: 'trip.updated',
    tripId: t.id,
    bookingId: t.bookingId,
    status: t.trackingStatus,
    lat: t.lastLat,
    lng: t.lastLng,
    lastSeenAt: t.lastSeenAt?.toISOString() ?? null,
    battery: t.lastBattery,
  });
}

// ── Status changes ────────────────────────────────────────────────────────────

/**
 * Apply a new tracking status: log the timeline event and tell the admins
 * about the ones that need attention.
 */
async function applyStatus(trip: TripWithBooking, next: { status: TrackingStatus; since: Date }, s: Settings, now: Date) {
  const prev = trip.trackingStatus;
  if (prev === next.status) return;
  let lastAddress = trip.lastAddress;
  if (next.status !== 'LIVE' && trip.lastLat != null && trip.lastLng != null) {
    lastAddress = await describeLocation(trip.lastLat, trip.lastLng);
  }
  await prisma.trip.update({
    where: { id: trip.id },
    data: { trackingStatus: next.status, trackingStatusSince: next.since, lastAddress },
  });
  const eventType = statusChangeEvent(prev, next.status);
  if (eventType) {
    await prisma.trackingEvent.create({
      data: {
        tripId: trip.id,
        type: eventType,
        occurredAt: eventType === 'OFFLINE' || eventType === 'TRACKING_LOST' ? next.since : now,
        source: 'SERVER',
        lat: trip.lastLat,
        lng: trip.lastLng,
        details: { lastSeenAt: trip.lastSeenAt?.toISOString() ?? null, battery: trip.lastBattery, address: lastAddress },
      },
    });
  }

  const tz = s.timezone;
  const near = lastAddress ? ` near ${lastAddress}` : '';
  const link = `/admin/trips/${trip.id}`;
  if (next.status === 'TRACKING_LOST') {
    await notify({
      to: { admins: true },
      type: 'TRACKING_LOST_URGENT',
      title: `Tracking lost: ${who(trip)}`,
      body: `Last seen ${fmtTime(trip.lastSeenAt ?? next.since, tz)}${near}${trip.lastBattery != null ? `, battery ${trip.lastBattery}%` : ''}.`,
      link,
      urgent: true,
    });
  } else if (next.status === 'LOCATION_OFF') {
    await notify({
      to: { admins: true },
      type: 'LOCATION_OFF',
      title: `Location turned off: ${who(trip)}`,
      body: `Location OFF at ${fmtTime(next.since, tz)}${near}.`,
      link,
      channels: ['IN_APP', 'PUSH'],
    });
  } else if (next.status === 'LIVE' && (prev === 'TRACKING_LOST' || prev === 'LOCATION_OFF')) {
    await notify({
      to: { admins: true },
      type: 'TRACKING_RESUMED',
      title: `Tracking back: ${who(trip)}`,
      body: prev === 'LOCATION_OFF' ? `Location back ON at ${fmtTime(now, tz)}.` : `Back in contact at ${fmtTime(now, tz)}.`,
      link,
      channels: ['IN_APP'],
    });
  }
}

/** Recompute a running trip's tracking status from its last contact. Used by the worker. */
export async function refreshTrackingStatus(tripId: string, now = new Date()) {
  const trip = await loadTrip(tripId);
  if (!trip || trip.booking.status !== 'IN_PROGRESS') return;
  const s = await getSettings();
  const next = deriveTrackingStatus(
    { lastContactAt: trip.lastContactAt, locationOffSince: trip.locationOffSince, lastBattery: trip.lastBattery, startedAt: trip.startedAt },
    now,
    s,
  );
  if (next.status !== trip.trackingStatus) {
    await applyStatus(trip, next, s, now);
    await liveUpdate(trip.id);
  }
}

// ── GPS ingest ────────────────────────────────────────────────────────────────

/**
 * Store locations posted by the device (live or backfilled after being
 * offline), then update the trip's last position, status, stop times and
 * office arrival.
 */
export async function ingestLocations(tripId: string, locations: DeviceLocation[], now = new Date()) {
  const trip = await loadTrip(tripId);
  if (!trip) return { accepted: 0 };
  const s = await getSettings();
  const until = trip.endedAt ?? trip.awaitingOdometerAt;

  const rows: Prisma.LocationPointCreateManyInput[] = [];
  for (const l of locations) {
    const recordedAt = new Date(l.timestamp);
    if (Number.isNaN(recordedAt.getTime())) continue;
    if (recordedAt.getTime() < trip.startedAt.getTime() - MINUTE) continue;
    if (until && recordedAt.getTime() > until.getTime() + MINUTE) continue;
    if (recordedAt.getTime() > now.getTime() + 5 * MINUTE) continue;
    rows.push({
      tripId,
      recordedAt,
      lat: l.coords.latitude,
      lng: l.coords.longitude,
      accuracy: l.coords.accuracy ?? null,
      speed: l.coords.speed != null && l.coords.speed >= 0 ? l.coords.speed : null,
      heading: l.coords.heading != null && l.coords.heading >= 0 ? l.coords.heading : null,
      altitude: l.coords.altitude ?? null,
      battery: batteryPct(l.battery?.level),
      isCharging: l.battery?.is_charging ?? null,
      isMoving: l.is_moving ?? null,
      activity: l.activity?.type ?? null,
      event: l.event ?? null,
      uuid: l.uuid ?? null,
    });
  }

  const data: Prisma.TripUpdateInput = { lastContactAt: now };
  if (rows.length) {
    await prisma.locationPoint.createMany({ data: rows, skipDuplicates: true });
    const newest = rows.reduce((a, b) => (a.recordedAt > b.recordedAt ? a : b));
    if (!trip.lastSeenAt || (newest.recordedAt as Date) > trip.lastSeenAt) {
      Object.assign(data, {
        lastLat: newest.lat,
        lastLng: newest.lng,
        lastAccuracy: newest.accuracy,
        lastSeenAt: newest.recordedAt,
        lastBattery: newest.battery ?? trip.lastBattery,
      });
    }
    // Fresh, usable fixes after location was reported off mean it's back on,
    // even if the "location on" event itself was lost.
    if (trip.locationOffSince) {
      const after = rows.filter((r) => (r.recordedAt as Date) > trip.locationOffSince! && (r.accuracy ?? 0) <= s.maxFixAccuracyM);
      if (after.length) {
        data.locationOffSince = null;
        await prisma.trackingEvent.create({
          data: { tripId, type: 'LOCATION_ON', occurredAt: after[0]!.recordedAt as Date, source: 'SERVER', details: { inferred: 'GPS fixes resumed' } },
        });
      }
    }
  }
  const updated = await prisma.trip.update({ where: { id: tripId }, data, include: tripInclude });

  if (updated.booking.status === 'IN_PROGRESS') {
    const next = deriveTrackingStatus(
      { lastContactAt: now, locationOffSince: updated.locationOffSince, lastBattery: updated.lastBattery, startedAt: updated.startedAt },
      now,
      s,
    );
    await applyStatus(updated, next, s, now);
    if (rows.length) await detectZones(updated, s);
    await checkLowBattery(updated, s);
  }
  await liveUpdate(tripId);
  return { accepted: rows.length };
}

async function checkLowBattery(trip: TripWithBooking, s: Settings) {
  if (trip.lastBattery == null || trip.lastBattery > s.lowBatteryPct) return;
  const already = await prisma.trackingEvent.count({ where: { tripId: trip.id, type: 'LOW_BATTERY' } });
  if (already) return;
  await prisma.trackingEvent.create({
    data: { tripId: trip.id, type: 'LOW_BATTERY', occurredAt: trip.lastSeenAt ?? new Date(), source: 'SERVER', details: { battery: trip.lastBattery } },
  });
  await notify({
    to: { userIds: [trip.booking.ownerId] },
    type: 'LOW_BATTERY',
    title: 'Phone battery low',
    body: `Your battery is at ${trip.lastBattery}%. Trip tracking stops if the phone dies. Charge it if you can.`,
    link: `/trips/${trip.bookingId}`,
    channels: ['IN_APP', 'PUSH'],
  });
}

/** Arrival/departure at each stop and arrival back at the office, from the GPS track. */
async function detectZones(trip: TripWithBooking, s: Settings) {
  const fixes = await prisma.locationPoint.findMany({
    where: { tripId: trip.id },
    orderBy: { recordedAt: 'asc' },
    select: { lat: true, lng: true, recordedAt: true, accuracy: true },
  });
  if (fixes.length < 2) return;

  const auto = trip.booking.stops.filter((st) => !st.manualTimes && st.status !== 'DEPARTED');
  const visits = detectStopVisits(fixes, auto, { radiusM: s.stopArrivalRadiusM, dwellMin: s.stopDwellMin, maxAccuracyM: s.maxFixAccuracyM });
  for (const stop of auto) {
    const v = visits.get(stop.id);
    if (!v) continue;
    const events: Prisma.TrackingEventCreateManyInput[] = [];
    const data: Prisma.BookingStopUpdateInput = {};
    if (!stop.arrivedAt) {
      data.arrivedAt = v.arrivedAt;
      data.status = 'ARRIVED';
      events.push({ tripId: trip.id, type: 'STOP_ARRIVED', occurredAt: v.arrivedAt, source: 'SERVER', lat: stop.lat, lng: stop.lng, details: { stopId: stop.id, seq: stop.seq, address: stop.address } });
    }
    if (v.departedAt && !stop.departedAt) {
      data.departedAt = v.departedAt;
      data.status = 'DEPARTED';
      events.push({ tripId: trip.id, type: 'STOP_DEPARTED', occurredAt: v.departedAt, source: 'SERVER', lat: stop.lat, lng: stop.lng, details: { stopId: stop.id, seq: stop.seq, address: stop.address } });
    }
    if (events.length) {
      await prisma.bookingStop.update({ where: { id: stop.id }, data });
      await prisma.trackingEvent.createMany({ data: events });
    }
  }

  if (!trip.officeArrivedAt) {
    const o = await office(trip);
    if (!o) return;
    const visit = detectOfficeArrival(fixes, { lat: o.lat, lng: o.lng, arrivalRadiusM: o.arrivalRadiusM, wakeupRadiusM: o.wakeupRadiusM }, { dwellMin: s.officeDwellMin, maxAccuracyM: s.maxFixAccuracyM });
    if (!visit) return;
    await prisma.trip.update({ where: { id: trip.id }, data: { officeArrivedAt: visit.arrivedAt } });
    await prisma.trackingEvent.create({ data: { tripId: trip.id, type: 'OFFICE_ARRIVED', occurredAt: visit.arrivedAt, source: 'SERVER', lat: o.lat, lng: o.lng } });
    await notify({
      to: { userIds: [trip.booking.ownerId] },
      type: 'END_TRIP_PROMPT',
      title: 'Back at the office?',
      body: 'End the trip and enter the odometer reading.',
      link: `/trips/${trip.bookingId}?end=1`,
      channels: ['IN_APP', 'PUSH'],
    });
  }
}

// ── Device events ─────────────────────────────────────────────────────────────

export interface DeviceEventInput {
  clientEventId: string;
  type: TrackingEventType;
  occurredAt: Date;
  details?: Record<string, unknown>;
  lat?: number;
  lng?: number;
  battery?: number;
}

/**
 * Events the phone reports: location services or permission changes, its own
 * network on/off log (uploaded after reconnecting), airplane mode, geofence.
 */
export async function ingestDeviceEvents(tripId: string, events: DeviceEventInput[], now = new Date()) {
  const trip = await loadTrip(tripId);
  if (!trip) return { accepted: 0 };
  const s = await getSettings();
  const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const result = await prisma.trackingEvent.createMany({
    data: sorted.map((e) => ({
      tripId,
      type: e.type,
      occurredAt: e.occurredAt,
      source: 'DEVICE' as const,
      details: (e.details ?? undefined) as Prisma.InputJsonValue | undefined,
      lat: e.lat ?? null,
      lng: e.lng ?? null,
      clientEventId: e.clientEventId,
    })),
    skipDuplicates: true,
  });

  let locationOffSince = trip.locationOffSince;
  let battery = trip.lastBattery;
  for (const e of sorted) {
    const permissionDowngraded = e.type === 'PERMISSION_CHANGED' && e.details?.always === false;
    if (e.type === 'LOCATION_OFF' || permissionDowngraded) {
      locationOffSince ??= e.occurredAt;
    } else if (e.type === 'LOCATION_ON' || (e.type === 'PERMISSION_CHANGED' && e.details?.always === true)) {
      if (!locationOffSince || e.occurredAt >= locationOffSince) locationOffSince = null;
    }
    if (e.battery != null) battery = Math.round(e.battery);
  }
  const updated = await prisma.trip.update({
    where: { id: tripId },
    data: { lastContactAt: now, locationOffSince, lastBattery: battery },
    include: tripInclude,
  });
  if (updated.booking.status === 'IN_PROGRESS') {
    const next = deriveTrackingStatus({ lastContactAt: now, locationOffSince, lastBattery: battery, startedAt: updated.startedAt }, now, s);
    await applyStatus(updated, next, s, now);
  }
  await liveUpdate(tripId);
  return { accepted: result.count };
}

/** Device contact without data (e.g. the app opened): counts as a heartbeat. */
export async function touchTrip(tripId: string, now = new Date()) {
  await prisma.trip.update({ where: { id: tripId }, data: { lastContactAt: now } });
  await refreshTrackingStatus(tripId, now);
}
