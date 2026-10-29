import { describe, expect, it } from 'vitest';
import {
  assertCanStartTrip,
  assertTransition,
  canTransition,
  checkAvailability,
  findConflicts,
  isNoShow,
  isOverdue,
  validateBookingWindow,
  type SlotBooking,
} from './booking';
import { DomainError } from './errors';

const T = (hhmm: string, day = '2026-11-02') => new Date(`${day}T${hhmm}:00+03:00`);
const settings = { startWindowMin: 30, noShowWindowMin: 30, overdueGraceMin: 15 };

const booking = (over: Partial<SlotBooking> & { id: string }): SlotBooking => ({
  status: 'APPROVED',
  startAt: T('10:00'),
  expectedReturnAt: T('13:00'),
  carId: 'car1',
  driverId: 'drv1',
  ownerId: 'jane',
  ...over,
});

const cars = [
  { id: 'car1', status: 'AVAILABLE' as const },
  { id: 'car2', status: 'AVAILABLE' as const },
  { id: 'car3', status: 'MAINTENANCE' as const },
];
const drivers = [{ id: 'drv1', active: true }];

describe('booking state machine', () => {
  it('allows the documented transitions', () => {
    expect(canTransition('PENDING', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('APPROVED', 'NO_SHOW')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'AWAITING_ODOMETER')).toBe(true);
    expect(canTransition('AWAITING_ODOMETER', 'COMPLETED')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(canTransition('PENDING', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
    expect(() => assertTransition('REJECTED', 'APPROVED')).toThrow(DomainError);
  });
});

describe('checkAvailability', () => {
  const now = T('08:00');

  it('is bookable when the driver and a car are free', () => {
    const a = checkAvailability({ start: T('10:00'), end: T('12:00'), now, cars, drivers, bookings: [] });
    expect(a.bookable).toBe(true);
    expect(a.driver.driverId).toBe('drv1');
    expect(a.cars.find((c) => c.carId === 'car3')).toMatchObject({ available: false, reason: 'MAINTENANCE' });
  });

  it('reports the driver as out when an approved trip overlaps, even on another car', () => {
    const jane = booking({ id: 'b1', carId: 'car2' });
    const a = checkAvailability({ start: T('11:00'), end: T('12:00'), now, cars, drivers, bookings: [jane] });
    expect(a.bookable).toBe(false);
    expect(a.driver.available).toBe(false);
    expect(a.driver.busyWith.map((b) => b.id)).toEqual(['b1']);
    // car1 itself is free; it's the single driver that blocks.
    expect(a.cars.find((c) => c.carId === 'car1')?.available).toBe(true);
    expect(a.cars.find((c) => c.carId === 'car2')?.reason).toBe('BOOKED');
  });

  it('treats back-to-back bookings as not overlapping', () => {
    const jane = booking({ id: 'b1' });
    const a = checkAvailability({ start: T('13:00'), end: T('14:00'), now, cars, drivers, bookings: [jane] });
    expect(a.bookable).toBe(true);
  });

  it('shows pending overlaps as tentative without blocking', () => {
    const pending = booking({ id: 'p1', status: 'PENDING' });
    const a = checkAvailability({ start: T('11:00'), end: T('12:00'), now, cars, drivers, bookings: [pending] });
    expect(a.bookable).toBe(true);
    expect(a.tentative.map((b) => b.id)).toEqual(['p1']);
    expect(a.cars.find((c) => c.carId === 'car1')?.tentative).toHaveLength(1);
  });

  it('keeps an overdue trip blocking until it actually ends', () => {
    const late = booking({ id: 'b1', status: 'IN_PROGRESS' });
    const a = checkAvailability({ start: T('13:30'), end: T('14:30'), now: T('13:45'), cars, drivers, bookings: [late] });
    expect(a.driver.available).toBe(false);
  });

  it('frees up when a second driver exists', () => {
    const jane = booking({ id: 'b1' });
    const a = checkAvailability({
      start: T('11:00'),
      end: T('12:00'),
      now,
      cars,
      drivers: [...drivers, { id: 'drv2', active: true }],
      bookings: [jane],
    });
    expect(a.driver.driverId).toBe('drv2');
    expect(a.bookable).toBe(true);
  });

  it('ignores cancelled, rejected and completed bookings', () => {
    const bookings = (['CANCELLED', 'REJECTED', 'COMPLETED', 'NO_SHOW'] as const).map((status, i) => booking({ id: `x${i}`, status }));
    const a = checkAvailability({ start: T('10:30'), end: T('11:00'), now, cars, drivers, bookings });
    expect(a.bookable).toBe(true);
  });

  it('flags when no driver is configured', () => {
    const a = checkAvailability({ start: T('10:00'), end: T('11:00'), now, cars, drivers: [], bookings: [] });
    expect(a.driver.noDriverConfigured).toBe(true);
    expect(a.bookable).toBe(false);
  });
});

describe('findConflicts', () => {
  it('finds driver and car clashes for a later return time', () => {
    const next = booking({ id: 'next', startAt: T('14:00'), expectedReturnAt: T('16:00'), carId: 'car2' });
    const c = findConflicts(
      { id: 'b1', startAt: T('10:00'), expectedReturnAt: T('14:30'), carId: 'car1', driverId: 'drv1' },
      [next],
      T('08:00'),
    );
    expect(c.driver.map((b) => b.id)).toEqual(['next']);
    expect(c.car).toEqual([]);
  });
});

describe('trip timing', () => {
  const b = { status: 'APPROVED' as const, startAt: T('10:00'), ownerId: 'jane', expectedReturnAt: T('13:00') };

  it('opens the start window 30 minutes early, only to the owner', () => {
    expect(() => assertCanStartTrip(b, 'jane', T('09:29'), settings)).toThrow(/30 minutes/);
    expect(() => assertCanStartTrip(b, 'jane', T('09:30'), settings)).not.toThrow();
    expect(() => assertCanStartTrip(b, 'bob', T('10:00'), settings)).toThrow(/Only the staff member/);
    expect(() => assertCanStartTrip(b, 'jane', T('10:31'), settings)).toThrow(/start window has passed/);
  });

  it('marks a no-show 30 minutes after the start', () => {
    expect(isNoShow(b, T('10:30'), settings)).toBe(false);
    expect(isNoShow(b, T('10:31'), settings)).toBe(true);
    expect(isNoShow({ ...b, status: 'IN_PROGRESS' }, T('11:00'), settings)).toBe(false);
  });

  it('marks a trip overdue after ETA plus grace', () => {
    const t = { ...b, status: 'IN_PROGRESS' as const };
    expect(isOverdue(t, T('13:15'), settings)).toBe(false);
    expect(isOverdue(t, T('13:16'), settings)).toBe(true);
  });

  it('validates the booking window', () => {
    expect(() => validateBookingWindow(T('10:00'), T('09:00'), T('08:00'))).toThrow(/after the start/);
    expect(() => validateBookingWindow(T('07:00'), T('09:00'), T('08:00'))).toThrow(/past/);
    expect(() => validateBookingWindow(T('10:00'), T('12:00'), T('08:00'))).not.toThrow();
  });
});
