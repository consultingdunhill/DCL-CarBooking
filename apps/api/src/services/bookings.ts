import {
  checkAvailability,
  DomainError,
  describeBusySlot,
  findConflicts,
  JOINABLE_STATUSES,
  type LatLng,
  type StopInput,
} from '@carbooking/core';
import { prisma, type Prisma } from '@carbooking/db';
import { getSettings } from '@carbooking/server';
import { previewRoute } from '../lib/maps';

// ── Shapes returned to the web app ────────────────────────────────────────────

const userBrief = { select: { id: true, name: true, phone: true, email: true, department: true } } as const;

export const bookingInclude = {
  owner: userBrief,
  driver: { select: { id: true, name: true, phone: true } },
  car: { select: { id: true, registration: true, make: true, model: true, color: true, seats: true, status: true } },
  decidedBy: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  stops: {
    orderBy: { seq: 'asc' },
    include: {
      reason: { select: { id: true, label: true, department: true, countsAsViewing: true, needsProperty: true } },
      property: { select: { id: true, ref: true, address: true, service: true, client: { select: { id: true, name: true } } } },
      addedBy: { select: { id: true, name: true } },
    },
  },
  passengers: { include: { user: userBrief }, orderBy: { addedAt: 'asc' } },
  joinRequests: { where: { status: 'PENDING' }, include: { requester: userBrief }, orderBy: { createdAt: 'asc' } },
  trip: {
    select: {
      id: true,
      startedAt: true,
      endedAt: true,
      odometerStart: true,
      odometerEnd: true,
      unloggedKm: true,
      endMethod: true,
      gpsDistanceKm: true,
      trackingStatus: true,
      trackingStatusSince: true,
      lastLat: true,
      lastLng: true,
      lastSeenAt: true,
      lastBattery: true,
      lastAddress: true,
      etaAt: true,
      officeArrivedAt: true,
      awaitingOdometerAt: true,
    },
  },
} satisfies Prisma.BookingInclude;

export type BookingWithRelations = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;

/** Location is visible to admins only (Kenya DPA). */
export function redactForStaff(b: BookingWithRelations, viewer: { id: string; role: string }) {
  if (viewer.role === 'ADMIN' || !b.trip) return b;
  return { ...b, trip: { ...b.trip, lastLat: null, lastLng: null, lastAddress: null } };
}

// ── Office ────────────────────────────────────────────────────────────────────

export async function getOffice() {
  const office = await prisma.office.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!office) throw new DomainError('NO_OFFICE', 'The office location has not been set up yet. Ask an admin to add it in Settings.', 409);
  return office;
}

// ── Availability ──────────────────────────────────────────────────────────────

const slotInclude = {
  owner: { select: { id: true, name: true, phone: true } },
  car: { select: { id: true, registration: true } },
  stops: { where: { status: { notIn: ['REJECTED', 'PROPOSED'] } }, orderBy: { seq: 'asc' }, select: { address: true, label: true, property: { select: { ref: true } } } },
  trip: { select: { etaAt: true } },
} satisfies Prisma.BookingInclude;
type SlotRow = Prisma.BookingGetPayload<{ include: typeof slotInclude }>;

/** Bookings that might overlap [start, end): live ones within a day either side. */
async function loadSlots(start: Date, end: Date): Promise<SlotRow[]> {
  const day = 24 * 3600_000;
  return prisma.booking.findMany({
    where: {
      status: { in: ['PENDING', 'APPROVED', 'IN_PROGRESS'] },
      startAt: { lt: new Date(end.getTime() + day) },
      expectedReturnAt: { gt: new Date(start.getTime() - day) },
    },
    include: slotInclude,
  });
}

/** For availability, a trip that's out is held until its (possibly extended) ETA. */
const slotEnd = (b: SlotRow) => (b.status === 'IN_PROGRESS' && b.trip?.etaAt && b.trip.etaAt > b.expectedReturnAt ? b.trip.etaAt : b.expectedReturnAt);

function destinationsOf(b: SlotRow) {
  return b.stops.map((s) => s.label || areaOf(s.address));
}

/** "4 bed villa, Lavington Green, Lavington" → "Lavington" (the area is the useful bit). */
function areaOf(address: string) {
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? address;
}

export async function slotDto(b: SlotRow) {
  const { timezone } = await getSettings();
  const expectedReturnAt = slotEnd(b);
  const destinations = destinationsOf(b);
  return {
    bookingId: b.id,
    status: b.status,
    startAt: b.startAt,
    expectedReturnAt,
    owner: b.owner,
    car: b.car,
    destinations,
    description: describeBusySlot({ ownerName: b.owner.name, startAt: b.startAt, expectedReturnAt, destinations }, timezone),
    joinable: (JOINABLE_STATUSES as string[]).includes(b.status),
  };
}

export async function availability(start: Date, end: Date, excludeBookingId?: string) {
  const [cars, drivers, slots] = await Promise.all([
    prisma.car.findMany({ where: { status: { not: 'RETIRED' } }, orderBy: { registration: 'asc' } }),
    prisma.driver.findMany(),
    loadSlots(start, end),
  ]);
  const result = checkAvailability({
    start,
    end,
    now: new Date(),
    cars,
    drivers,
    bookings: slots.map((b) => ({ ...b, expectedReturnAt: slotEnd(b), row: b })),
    excludeBookingId,
  });
  const dto = (b: { row: SlotRow }) => slotDto(b.row);
  return {
    bookable: result.bookable,
    driver: {
      available: result.driver.available,
      driverId: result.driver.driverId,
      noDriverConfigured: result.driver.noDriverConfigured,
      busyWith: await Promise.all(result.driver.busyWith.map(dto)),
    },
    cars: await Promise.all(
      result.cars.map(async (c) => ({
        car: cars.find((x) => x.id === c.carId)!,
        available: c.available,
        reason: c.reason,
        blocking: await Promise.all(c.blocking.map(dto)),
        tentative: await Promise.all(c.tentative.map(dto)),
      })),
    ),
    tentative: await Promise.all(result.tentative.map(dto)),
  };
}

/** Clashes approving a booking (optionally reassigned, or with a later return) would hit. */
export async function conflictsFor(target: { id: string; startAt: Date; expectedReturnAt: Date; carId: string; driverId: string }) {
  const slots = await loadSlots(target.startAt, target.expectedReturnAt);
  const c = findConflicts(target, slots.map((b) => ({ ...b, expectedReturnAt: slotEnd(b) })), new Date());
  const byId = new Map(slots.map((s) => [s.id, s]));
  const dto = (list: { id: string }[]) => Promise.all(list.map((b) => slotDto(byId.get(b.id)!)));
  return { car: await dto(c.car), driver: await dto(c.driver), pendingOverlaps: await dto(c.pendingOverlaps) };
}

// ── Stops ─────────────────────────────────────────────────────────────────────

/**
 * Check each stop's reason and property, and return rows ready to insert.
 * Viewings, inspections and valuations must be linked to a property.
 */
export async function prepareStops(stops: StopInput[], addedById: string, startSeq: number, extra: Partial<Prisma.BookingStopCreateManyInput> = {}) {
  const reasonIds = [...new Set(stops.map((s) => s.reasonId))];
  const propertyIds = [...new Set(stops.map((s) => s.propertyId).filter((x): x is string => Boolean(x)))];
  const [reasons, properties] = await Promise.all([
    prisma.visitReason.findMany({ where: { id: { in: reasonIds } } }),
    prisma.property.findMany({ where: { id: { in: propertyIds } } }),
  ]);
  return stops.map((s, i) => {
    const reason = reasons.find((r) => r.id === s.reasonId);
    if (!reason || !reason.active) throw new DomainError('INVALID_REASON', `Stop ${i + 1}: choose a reason for the visit`);
    if (reason.needsProperty && !s.propertyId) {
      throw new DomainError('PROPERTY_REQUIRED', `Stop ${i + 1}: "${reason.label}" must be linked to a property`);
    }
    const property = s.propertyId ? properties.find((p) => p.id === s.propertyId) : null;
    if (s.propertyId && !property) throw new DomainError('INVALID_PROPERTY', `Stop ${i + 1}: property not found`);
    return {
      seq: startSeq + i,
      propertyId: property?.id ?? null,
      placeId: s.placeId ?? null,
      label: s.label ?? (property ? property.ref : null),
      address: s.address,
      lat: s.lat,
      lng: s.lng,
      addedById,
      reasonId: reason.id,
      note: s.note ?? null,
      crmLeadRef: s.crmLeadRef ?? null,
      crmLeadName: s.crmLeadRef ? (s.crmLeadName ?? null) : null,
      ...extra,
    } satisfies Omit<Prisma.BookingStopCreateManyInput, 'bookingId'>;
  });
}

/** Office → stops → office. */
export async function planRoute(stops: LatLng[]) {
  const office = await getOffice();
  const origin = { lat: office.lat, lng: office.lng };
  return previewRoute([origin, ...stops, origin]);
}

/** Recalculate the planned route after stops change (e.g. a join is approved). */
export async function replanBooking(bookingId: string) {
  const stops = await prisma.bookingStop.findMany({
    where: { bookingId, status: { in: ['PLANNED', 'ARRIVED', 'DEPARTED'] } },
    orderBy: { seq: 'asc' },
  });
  if (stops.length === 0) return;
  const route = await planRoute(stops);
  await prisma.booking.update({
    where: { id: bookingId },
    data: { plannedDistanceKm: route.distanceKm, plannedDurationMin: route.durationMin, plannedPolyline: route.polyline },
  });
}
