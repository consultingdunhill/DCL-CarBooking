import type { BookingStatus, CarStatus, JoinRequestStatus } from './enums';
import { DomainError } from './errors';
import { MINUTE, rangesOverlap } from './time';

// ── State machines ────────────────────────────────────────────────────────────

export const BOOKING_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED', 'AWAITING_ODOMETER'],
  AWAITING_ODOMETER: ['COMPLETED'],
  REJECTED: [],
  CANCELLED: [],
  COMPLETED: [],
  NO_SHOW: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError('INVALID_TRANSITION', `A ${label(from)} booking can't become ${label(to)}`, 409, { from, to });
  }
}

export const JOIN_TRANSITIONS: Record<JoinRequestStatus, readonly JoinRequestStatus[]> = {
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function assertJoinTransition(from: JoinRequestStatus, to: JoinRequestStatus): void {
  if (!JOIN_TRANSITIONS[from].includes(to)) {
    throw new DomainError('INVALID_TRANSITION', `A ${label(from)} join request can't become ${label(to)}`, 409);
  }
}

const label = (s: string) => s.toLowerCase().replace(/_/g, ' ');

/** Statuses that hold the car and the driver. Mirrors the database exclusion constraints. */
export const BLOCKING_STATUSES: readonly BookingStatus[] = ['APPROVED', 'IN_PROGRESS'];
/** Statuses shown as "tentative" overlaps. */
export const TENTATIVE_STATUSES: readonly BookingStatus[] = ['PENDING'];
/** Bookings someone can ask to add a stop to. */
export const JOINABLE_STATUSES: readonly BookingStatus[] = ['PENDING', 'APPROVED', 'IN_PROGRESS'];
/** Bookings that are still live (not finished one way or another). */
export const OPEN_STATUSES: readonly BookingStatus[] = ['PENDING', 'APPROVED', 'IN_PROGRESS', 'AWAITING_ODOMETER'];

export const isBlocking = (s: BookingStatus) => BLOCKING_STATUSES.includes(s);

// ── Booking window validation ─────────────────────────────────────────────────

export const MAX_BOOKING_HOURS = 24;
export const MAX_STOPS = 12;

export function validateBookingWindow(startAt: Date, returnAt: Date, now: Date, opts: { allowPast?: boolean } = {}): void {
  if (!(returnAt > startAt)) {
    throw new DomainError('INVALID_WINDOW', 'The return time must be after the start time');
  }
  if (returnAt.getTime() - startAt.getTime() > MAX_BOOKING_HOURS * 60 * MINUTE) {
    throw new DomainError('INVALID_WINDOW', `A booking can't be longer than ${MAX_BOOKING_HOURS} hours`);
  }
  if (!opts.allowPast && startAt.getTime() < now.getTime() - 5 * MINUTE) {
    throw new DomainError('INVALID_WINDOW', 'The start time is in the past');
  }
}

// ── Availability ──────────────────────────────────────────────────────────────

export interface SlotBooking {
  id: string;
  status: BookingStatus;
  startAt: Date;
  expectedReturnAt: Date;
  carId: string;
  driverId: string;
  ownerId: string;
}

export interface CarLite {
  id: string;
  status: CarStatus;
}

export interface DriverLite {
  id: string;
  active: boolean;
}

/**
 * When a booking stops holding its resources. A trip that is still out holds
 * the car and driver until it actually ends, even past its expected return.
 */
export function effectiveEnd(b: Pick<SlotBooking, 'status' | 'expectedReturnAt'>, now: Date): Date {
  if (b.status === 'IN_PROGRESS' && now > b.expectedReturnAt) return now;
  return b.expectedReturnAt;
}

function overlapsWindow(b: SlotBooking, start: Date, end: Date, now: Date) {
  return rangesOverlap(b.startAt, effectiveEnd(b, now), start, end);
}

export interface AvailabilityInput<B extends SlotBooking> {
  start: Date;
  end: Date;
  now: Date;
  cars: CarLite[];
  drivers: DriverLite[];
  bookings: B[];
  /** Ignore this booking (when editing or re-checking it). */
  excludeBookingId?: string;
}

export interface CarAvailability<B> {
  carId: string;
  available: boolean;
  reason: 'MAINTENANCE' | 'RETIRED' | 'BOOKED' | null;
  blocking: B[];
  tentative: B[];
}

export interface Availability<B> {
  driver: {
    available: boolean;
    /** A free driver to assign, when there is one. */
    driverId: string | null;
    /** Approved or in-progress trips holding every driver during the window. */
    busyWith: B[];
    noDriverConfigured: boolean;
  };
  cars: CarAvailability<B>[];
  /** Pending requests overlapping the window (shown as tentative). */
  tentative: B[];
  /** True when a trip can be booked: a driver and at least one car are free. */
  bookable: boolean;
}

/**
 * Check the driver first, then the cars, for a window. Only APPROVED and
 * IN_PROGRESS bookings block; PENDING ones are reported as tentative.
 */
export function checkAvailability<B extends SlotBooking>(input: AvailabilityInput<B>): Availability<B> {
  const { start, end, now } = input;
  const relevant = input.bookings.filter((b) => b.id !== input.excludeBookingId && overlapsWindow(b, start, end, now));
  const blocking = relevant.filter((b) => isBlocking(b.status));
  const tentative = relevant.filter((b) => TENTATIVE_STATUSES.includes(b.status));

  const activeDrivers = input.drivers.filter((d) => d.active);
  const freeDriver = activeDrivers.find((d) => !blocking.some((b) => b.driverId === d.id));
  const busyWith = freeDriver ? [] : blocking.filter((b) => activeDrivers.some((d) => d.id === b.driverId));

  const cars = input.cars.map<CarAvailability<B>>((car) => {
    const carBlocking = blocking.filter((b) => b.carId === car.id);
    const carTentative = tentative.filter((b) => b.carId === car.id);
    let reason: CarAvailability<B>['reason'] = null;
    if (car.status === 'MAINTENANCE') reason = 'MAINTENANCE';
    else if (car.status === 'RETIRED') reason = 'RETIRED';
    else if (carBlocking.length > 0) reason = 'BOOKED';
    return { carId: car.id, available: reason === null, reason, blocking: carBlocking, tentative: carTentative };
  });

  return {
    driver: {
      available: Boolean(freeDriver),
      driverId: freeDriver?.id ?? null,
      busyWith,
      noDriverConfigured: activeDrivers.length === 0,
    },
    cars,
    tentative,
    bookable: Boolean(freeDriver) && cars.some((c) => c.available),
  };
}

/**
 * Conflicts that approving `booking` (optionally on another car/driver, or with
 * a later return) would hit. Used for the admin's clash warning before approval.
 */
export function findConflicts<B extends SlotBooking>(
  target: Pick<SlotBooking, 'id' | 'startAt' | 'expectedReturnAt' | 'carId' | 'driverId'>,
  bookings: B[],
  now: Date,
): { car: B[]; driver: B[]; pendingOverlaps: B[] } {
  const others = bookings.filter((b) => b.id !== target.id && overlapsWindow(b, target.startAt, target.expectedReturnAt, now));
  return {
    car: others.filter((b) => isBlocking(b.status) && b.carId === target.carId),
    driver: others.filter((b) => isBlocking(b.status) && b.driverId === target.driverId),
    pendingOverlaps: others.filter((b) => b.status === 'PENDING' && (b.carId === target.carId || b.driverId === target.driverId)),
  };
}

// ── Trip timing rules ─────────────────────────────────────────────────────────

export interface TimingSettings {
  startWindowMin: number;
  noShowWindowMin: number;
  overdueGraceMin: number;
}

export function tripStartWindow(startAt: Date, s: TimingSettings): { opensAt: Date; closesAt: Date } {
  return {
    opensAt: new Date(startAt.getTime() - s.startWindowMin * MINUTE),
    closesAt: new Date(startAt.getTime() + s.noShowWindowMin * MINUTE),
  };
}

export function assertCanStartTrip(
  booking: { status: BookingStatus; startAt: Date; ownerId: string },
  userId: string,
  at: Date,
  s: TimingSettings,
): void {
  if (booking.ownerId !== userId) {
    throw new DomainError('NOT_TRIP_OWNER', 'Only the staff member who booked can start this trip', 403);
  }
  if (booking.status !== 'APPROVED') {
    throw new DomainError('NOT_APPROVED', `This booking is ${label(booking.status)}, so the trip can't start`, 409);
  }
  const { opensAt, closesAt } = tripStartWindow(booking.startAt, s);
  if (at < opensAt) {
    throw new DomainError('TOO_EARLY', `The trip can start from ${s.startWindowMin} minutes before the booked time`, 409, {
      opensAt,
    });
  }
  if (at > closesAt) {
    throw new DomainError('START_WINDOW_PASSED', 'The start window has passed and the booking was released', 409);
  }
}

export function isNoShow(b: { status: BookingStatus; startAt: Date }, now: Date, s: TimingSettings): boolean {
  return b.status === 'APPROVED' && now.getTime() > b.startAt.getTime() + s.noShowWindowMin * MINUTE;
}

export function isOverdue(b: { status: BookingStatus; expectedReturnAt: Date }, now: Date, s: TimingSettings): boolean {
  return b.status === 'IN_PROGRESS' && now.getTime() > b.expectedReturnAt.getTime() + s.overdueGraceMin * MINUTE;
}
