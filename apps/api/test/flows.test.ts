/**
 * End-to-end API flows against a real Postgres, covering the acceptance
 * scenarios that don't need a phone (DEVELOPMENT_PLAN §8).
 */
import { runNoShowCheck, runOverdueCheck, runTrackingMonitor, refreshTrackingStatus, stopBoss } from '@carbooking/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, fix, loginAs, MIN, north, OFFICE, prisma, seedBasics, uploadPhoto, type Client } from './helpers';

let app: FastifyInstance;
let s: Awaited<ReturnType<typeof seedBasics>>;
let admin: Client;
let admin2: Client;
let jane: Client;
let tom: Client;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(async () => {
  await app.close();
  await stopBoss();
  await prisma.$disconnect();
});
beforeEach(async () => {
  s = await seedBasics();
  [admin, admin2, jane, tom] = await Promise.all([s.admin, s.admin2, s.jane, s.tom].map((u) => loginAs(app, u.id)));
});

const inHours = (h: number) => new Date(Math.ceil((Date.now() + h * 3600_000) / 900_000) * 900_000);
const stop = (over: Record<string, unknown> = {}) => ({ address: s.property.address, lat: s.property.lat, lng: s.property.lng, reasonId: s.viewing.id, propertyId: s.property.id, ...over });

async function book(client: Client, carId: string, start: Date, end: Date, stops = [stop()]) {
  return client.post('/bookings', { carId, startAt: start.toISOString(), expectedReturnAt: end.toISOString(), stops });
}

/** An approved booking that started `minsAgo` minutes ago (set up directly; the API refuses past starts). */
async function approvedBookingStartedAgo(minsAgo: number, durationMin = 120) {
  const startAt = new Date(Date.now() - minsAgo * MIN);
  return prisma.booking.create({
    data: {
      ownerId: s.jane.id,
      driverId: s.driver.id,
      carId: s.car1.id,
      status: 'APPROVED',
      startAt,
      expectedReturnAt: new Date(startAt.getTime() + durationMin * MIN),
      stops: { create: [{ seq: 1, address: s.property.address, lat: s.property.lat!, lng: s.property.lng!, addedById: s.jane.id, reasonId: s.viewing.id, propertyId: s.property.id }] },
    },
  });
}

async function startTrip(bookingId: string, odometer: number, startedAt?: Date) {
  const photoKey = await uploadPhoto(app, jane, 'ODOMETER_START');
  return jane.post(`/bookings/${bookingId}/trip/start`, { odometer, photoKey, clientRequestId: `start-${bookingId}`, startedAt: startedAt?.toISOString() });
}

async function postLocations(token: string, points: ReturnType<typeof fix>[]) {
  return app.inject({ method: 'POST', url: '/tracking/locations', payload: { location: points }, headers: { authorization: `Bearer ${token}` } });
}

describe('booking & approval', () => {
  it('rejects booking without a property for a viewing', async () => {
    const r = await book(jane, s.car1.id, inHours(2), inHours(4), [stop({ propertyId: null })]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PROPERTY_REQUIRED');
  });

  it('#1 overlapping requests: second sees who has the driver; concurrent approvals → only one succeeds', async () => {
    const start = inHours(3);
    const end = new Date(start.getTime() + 3 * 3600_000);
    const a = await book(jane, s.car1.id, start, end);
    const b = await book(tom, s.car2.id, new Date(start.getTime() + 3600_000), new Date(start.getTime() + 2 * 3600_000), [stop({ reasonId: s.errand.id, propertyId: null })]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201); // pending overlaps are only tentative

    const avail = await tom.get(`/bookings/availability?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
    expect(avail.body.tentative).toHaveLength(2);

    const [r1, r2] = await Promise.all([admin.post(`/bookings/${a.body.id}/approve`), admin2.post(`/bookings/${b.body.id}/approve`)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect([r1, r2].find((r) => r.status === 409)!.body.error.code).toBe('SLOT_TAKEN');

    // Now a third request in that window is told the driver is out, with who and where.
    const after = await tom.get(`/bookings/availability?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
    expect(after.body.driver.available).toBe(false);
    expect(after.body.driver.busyWith[0].description).toMatch(/^Driver is out with (Jane M\.|Tom O\.)/);
    expect(after.body.driver.busyWith[0].owner.phone).toBeTruthy();
  });

  it('a second admin deciding the same request is told it is already decided', async () => {
    const a = await book(jane, s.car1.id, inHours(2), inHours(3));
    const first = await admin.post(`/bookings/${a.body.id}/approve`);
    const second = await admin2.post(`/bookings/${a.body.id}/reject`, { reason: 'Too late' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it('reassigns the car on approval and requires a rejection reason', async () => {
    const a = await book(jane, s.car1.id, inHours(2), inHours(3));
    const r = await admin.post(`/bookings/${a.body.id}/approve`, { carId: s.car2.id });
    expect(r.body.car.id).toBe(s.car2.id);
    const b = await book(tom, s.car1.id, inHours(5), inHours(6), [stop({ reasonId: s.errand.id, propertyId: null })]);
    expect((await admin.post(`/bookings/${b.body.id}/reject`, {})).status).toBe(400);
    expect((await admin.post(`/bookings/${b.body.id}/reject`, { reason: 'Car needed elsewhere' })).body.status).toBe('REJECTED');
    const audits = await prisma.auditLog.count({ where: { action: { in: ['BOOKING_REASSIGNED_APPROVED', 'BOOKING_REJECTED'] } } });
    expect(audits).toBe(2);
  });

  it('#2 join flow: owner told, admin approves, stop and passenger added, return time moves', async () => {
    const start = inHours(3);
    const a = await book(jane, s.car1.id, start, new Date(start.getTime() + 2 * 3600_000));
    await admin.post(`/bookings/${a.body.id}/approve`);
    const later = new Date(start.getTime() + 3 * 3600_000);
    const j = await tom.post(`/bookings/${a.body.id}/join-requests`, {
      stops: [{ address: 'Bank, CBD', lat: -1.2864, lng: 36.8172, reasonId: s.errand.id }],
      proposedReturnAt: later.toISOString(),
    });
    expect(j.status).toBe(201);
    expect(await prisma.notification.count({ where: { userId: s.jane.id, type: 'JOIN_REQUESTED_OWNER', channel: 'IN_APP' } })).toBe(1);
    expect((await jane.get(`/bookings/${a.body.id}`)).body.status).toBe('APPROVED');

    const approvals = await admin.get('/approvals');
    expect(approvals.body.joinRequests).toHaveLength(1);

    const r = await admin.post(`/join-requests/${j.body.id}/approve`);
    expect(r.status).toBe(200);
    const planned = r.body.stops.filter((x: { status: string }) => x.status === 'PLANNED');
    expect(planned).toHaveLength(2);
    expect(planned[1].seq).toBe(2);
    expect(r.body.passengers.map((p: { user: { id: string } }) => p.user.id)).toEqual([s.tom.id]);
    expect(new Date(r.body.expectedReturnAt).getTime()).toBe(later.getTime());
    expect(r.body.plannedDistanceKm).toBeGreaterThan(a.body.plannedDistanceKm);
  });

  it('cancelling a booking cancels pending join requests and tells the joiner', async () => {
    const a = await book(jane, s.car1.id, inHours(3), inHours(5));
    const j = await tom.post(`/bookings/${a.body.id}/join-requests`, { stops: [{ address: 'CBD', lat: -1.28, lng: 36.82, reasonId: s.errand.id }] });
    await jane.post(`/bookings/${a.body.id}/cancel`, { reason: 'Client postponed' });
    expect((await prisma.joinRequest.findUnique({ where: { id: j.body.id } }))!.status).toBe('CANCELLED');
    expect(await prisma.notification.count({ where: { userId: s.tom.id, type: 'JOIN_CANCELLED' } })).toBeGreaterThan(0);
  });
});

describe('trips & tracking', () => {
  it('#3 odometer below the last reading is blocked; a higher one records unlogged km', async () => {
    const b = await approvedBookingStartedAgo(5);
    const low = await startTrip(b.id, 9_990);
    expect(low.status).toBe(422);
    expect(low.body.error.code).toBe('ODOMETER_BELOW_LAST');
    const ok = await jane.post(`/bookings/${b.id}/trip/start`, { odometer: 10_025, photoKey: await uploadPhoto(app, jane, 'ODOMETER_START'), clientRequestId: `again-${b.id}` });
    expect(ok.status).toBe(201);
    expect(ok.body.trip.unloggedKm).toBe(25);
    expect(ok.body.tracking.token).toBeTruthy();
    // Retrying with the same request ID (offline replay) returns the same trip.
    const again = await jane.post(`/bookings/${b.id}/trip/start`, { odometer: 10_025, photoKey: 'x', clientRequestId: `again-${b.id}` });
    expect(again.body.trip.id).toBe(ok.body.trip.id);
  });

  it('only the trip owner can start, and only inside the start window', async () => {
    const early = await prisma.booking.create({
      data: { ownerId: s.jane.id, driverId: s.driver.id, carId: s.car2.id, status: 'APPROVED', startAt: inHours(3), expectedReturnAt: inHours(4) },
    });
    expect((await startTrip(early.id, 20_000)).body.error.code).toBe('TOO_EARLY');
    const b = await approvedBookingStartedAgo(5);
    const photoKey = await uploadPhoto(app, tom, 'ODOMETER_START');
    const r = await tom.post(`/bookings/${b.id}/trip/start`, { odometer: 10_000, photoKey, clientRequestId: 'tom-tries' });
    expect(r.body.error.code).toBe('NOT_TRIP_OWNER');
  });

  it('#4–#6 location off, offline with backfill, tracking lost', async () => {
    const b = await approvedBookingStartedAgo(20);
    const started = new Date(Date.now() - 15 * MIN);
    const { body } = await startTrip(b.id, 10_000, started);
    const token = body.tracking.token;
    const tripId = body.trip.id;

    // Live fixes.
    expect((await postLocations(token, [fix(new Date(started.getTime() + MIN), north(500)), fix(new Date(started.getTime() + 2 * MIN), north(900))])).statusCode).toBe(200);
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: tripId } })).trackingStatus).toBe('LIVE');

    // #4 Location services turned off → admins see it straight away.
    const offAt = new Date(Date.now() - 10 * MIN);
    await app.inject({
      method: 'POST',
      url: '/tracking/events',
      headers: { authorization: `Bearer ${token}` },
      payload: { events: [{ clientEventId: 'evt-off-1', type: 'LOCATION_OFF', occurredAt: offAt.toISOString(), lat: north(900).lat, lng: north(900).lng }] },
    });
    let trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.trackingStatus).toBe('LOCATION_OFF');
    expect(trip.trackingStatusSince?.getTime()).toBe(offAt.getTime());
    expect(await prisma.notification.count({ where: { userId: s.admin.id, type: 'LOCATION_OFF', channel: 'IN_APP' } })).toBe(1);

    // Back on.
    await app.inject({
      method: 'POST',
      url: '/tracking/events',
      headers: { authorization: `Bearer ${token}` },
      payload: { events: [{ clientEventId: 'evt-on-1', type: 'LOCATION_ON', occurredAt: new Date(Date.now() - 8 * MIN).toISOString() }] },
    });
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: tripId } })).trackingStatus).toBe('LIVE');

    // #5 Silence for 6 minutes → Offline. Reconnect with buffered points → Live, route backfilled.
    await refreshTrackingStatus(tripId, new Date(Date.now() + 6 * MIN));
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: tripId } })).trackingStatus).toBe('OFFLINE');
    const backfill = [3, 4, 5, 6].map((m) => fix(new Date(Date.now() - (10 - m) * MIN), north(1000 + m * 300)));
    const res = await postLocations(token, backfill);
    expect(res.json().accepted).toBe(4);
    trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.trackingStatus).toBe('LIVE');
    const events = await prisma.trackingEvent.findMany({ where: { tripId }, orderBy: { occurredAt: 'asc' } });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['TRIP_STARTED', 'LOCATION_OFF', 'LOCATION_ON', 'OFFLINE', 'ONLINE']));
    // Duplicate re-sync is ignored.
    expect((await postLocations(token, backfill)).json().accepted).toBe(4);
    expect(await prisma.locationPoint.count({ where: { tripId } })).toBe(6);

    // #6 Long silence → tracking lost, with an urgent alert (SMS/WhatsApp queued).
    await refreshTrackingStatus(tripId, new Date(Date.now() + 31 * MIN));
    trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.trackingStatus).toBe('TRACKING_LOST');
    expect(trip.lastBattery).toBe(80);
    expect(await prisma.notification.count({ where: { type: 'TRACKING_LOST_URGENT', channel: 'SMS' } })).toBe(2);
  });

  it('#7 stopping within 20 m of the office prompts to end; ignoring it → AWAITING_ODOMETER; then end', async () => {
    const b = await approvedBookingStartedAgo(30);
    const started = new Date(Date.now() - 25 * MIN);
    const { body } = await startTrip(b.id, 10_000, started);
    const token = body.tracking.token;
    const tripId = body.trip.id;
    const t = (m: number) => new Date(started.getTime() + m * MIN);

    // Out to the property (dwell 5 min), back past the office without stopping.
    await postLocations(token, [
      fix(t(1), north(0)),
      fix(t(3), north(1500)),
      fix(t(6), north(3000)),
      fix(t(9), north(3005), { is_moving: false }),
      fix(t(11), north(3002)),
      fix(t(14), north(1500)),
      fix(t(16), north(200)),
      fix(t(16.5), north(5)),
      fix(t(17), north(-300)),
    ]);
    let trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.officeArrivedAt).toBeNull();
    const visited = await prisma.bookingStop.findFirstOrThrow({ where: { bookingId: b.id } });
    expect(visited.arrivedAt?.getTime()).toBe(t(6).getTime());
    expect(visited.departedAt?.getTime()).toBe(t(11).getTime());

    // Now come back and park.
    await postLocations(token, [fix(t(19), north(60)), fix(t(20), north(8)), fix(t(21), north(6), { is_moving: false }), fix(t(22.5), north(7))]);
    trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.officeArrivedAt?.getTime()).toBe(t(20).getTime());
    expect(await prisma.notification.count({ where: { userId: s.jane.id, type: 'END_TRIP_PROMPT', channel: 'IN_APP' } })).toBe(1);

    // Ignored for longer than the prompt timeout → awaiting odometer, tracking stops.
    await runTrackingMonitor(new Date(t(20).getTime() + 16 * MIN));
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('AWAITING_ODOMETER');
    const sync = await postLocations(token, [fix(new Date(), OFFICE)]);
    expect(sync.json().stopTracking).toBe(true);

    // The owner enters the reading later; the trip ends at the office arrival time.
    const photoKey = await uploadPhoto(app, jane, 'ODOMETER_END');
    const low = await jane.post(`/trips/${tripId}/end`, { odometer: 9_999, photoKey, clientRequestId: 'end-low-1' });
    expect(low.body.error.code).toBe('ODOMETER_BELOW_START');
    const end = await jane.post(`/trips/${tripId}/end`, { odometer: 10_008, photoKey, clientRequestId: 'end-ok-1' });
    expect(end.status).toBe(200);
    expect(end.body.status).toBe('COMPLETED');
    trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.endedAt?.getTime()).toBe(t(20).getTime());
    expect(trip.gpsDistanceKm).toBeGreaterThan(5);
    expect((await prisma.car.findUniqueOrThrow({ where: { id: s.car1.id } })).currentOdometer).toBe(10_008);

    // Staff don't get the GPS record; admins do, and the view is audit-logged.
    expect((await jane.get(`/trips/${tripId}`)).body.points).toEqual([]);
    expect((await admin.get(`/trips/${tripId}`)).body.points.length).toBeGreaterThan(5);
    expect(await prisma.auditLog.count({ where: { action: 'VIEW_LOCATION', entityId: tripId } })).toBe(1);
  });

  it('#8 overdue: owner pushed first, then admins by push and SMS', async () => {
    const b = await approvedBookingStartedAgo(100, 60);
    const { body } = await startTrip(b.id, 10_000, new Date(Date.now() - 95 * MIN));
    expect(body.trip).toBeTruthy();
    // ETA was 40 min ago: past ETA + 15 and ETA + 30.
    await runOverdueCheck(new Date(Date.now() - 20 * MIN));
    expect(await prisma.notification.count({ where: { type: 'OVERDUE', userId: s.jane.id } })).toBeGreaterThan(0);
    expect(await prisma.notification.count({ where: { type: 'OVERDUE_URGENT' } })).toBe(0);
    await runOverdueCheck(new Date());
    expect(await prisma.notification.count({ where: { type: 'OVERDUE_URGENT', channel: 'SMS', userId: s.admin.id } })).toBe(1);
    await runOverdueCheck(new Date());
    expect(await prisma.notification.count({ where: { type: 'OVERDUE_URGENT', channel: 'SMS', userId: s.admin.id } })).toBe(1);
  });

  it('extending the ETA past the next booking warns the next booker and admins', async () => {
    const b = await approvedBookingStartedAgo(10, 60);
    const { body } = await startTrip(b.id, 10_000);
    const next = await prisma.booking.create({
      data: { ownerId: s.tom.id, driverId: s.driver.id, carId: s.car2.id, status: 'APPROVED', startAt: new Date(b.expectedReturnAt.getTime() + 15 * MIN), expectedReturnAt: new Date(b.expectedReturnAt.getTime() + 75 * MIN) },
    });
    const r = await jane.post(`/trips/${body.trip.id}/extend`, { expectedReturnAt: new Date(b.expectedReturnAt.getTime() + 45 * MIN).toISOString() });
    expect(r.status).toBe(200);
    expect(r.body.clash.driver[0].bookingId).toBe(next.id);
    expect(await prisma.notification.count({ where: { type: 'ETA_CLASH', userId: s.tom.id, channel: 'IN_APP' } })).toBe(1);
  });

  it('#9 a booking not started within the no-show window is released', async () => {
    const b = await approvedBookingStartedAgo(31);
    await runNoShowCheck();
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('NO_SHOW');
    expect(await prisma.notification.count({ where: { type: 'NO_SHOW', userId: s.admin.id } })).toBeGreaterThan(0);
  });
});

describe('closures import & reports', () => {
  async function uploadCsv(url: string, csv: string) {
    const boundary = '----test';
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="closures.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    const token = admin.token!;
    return app.inject({ method: 'POST', url, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` } });
  }

  it('#13 imports matched rows and queues the unknown property reference for review', async () => {
    const csv = ['Property CRM Ref,Agent Email,Date Closed,Deal Type,Fee,Deal ID', 'CRM-1,jane@test.ke,15/10/2026,Sale,"450,000",D-1', 'CRM-404,jane@test.ke,16/10/2026,Sale,100000,D-2'].join('\n');
    const res = await uploadCsv('/admin/closures/import', csv);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rowCount: 2, matchedCount: 1, unmatchedCount: 1 });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: s.property.id } })).status).toBe('SOLD');
    const review = await admin.get('/admin/closures/review');
    expect(review.body).toHaveLength(1);
    expect(review.body[0].problems[0]).toMatch(/CRM-404/);

    // Re-importing skips the deal already imported.
    const again = await uploadCsv('/admin/closures/import', csv);
    expect(again.json().duplicateCount).toBe(1);

    const resolved = await admin.post(`/admin/closures/rows/${review.body[0].id}/resolve`, { propertyId: s.property.id, staffId: s.jane.id });
    expect(resolved.status).toBe(200);
    expect(await prisma.closure.count()).toBe(2);
  });

  it('serves reports as JSON, CSV and Excel', async () => {
    for (const id of ['fuel-efficiency', 'cost-per-km', 'usage', 'cost-allocation', 'compliance', 'cost-per-viewing', 'property-client-cost', 'staff-effectiveness']) {
      const r = await admin.get(`/reports/${id}?from=2026-09-01&to=2026-10-31`);
      expect(r.status, id).toBe(200);
      expect(r.body.columns.length, id).toBeGreaterThan(1);
    }
    const csv = await admin.get('/reports/compliance?from=2026-09-01&to=2026-10-31&format=csv');
    expect(csv.raw.headers['content-type']).toContain('text/csv');
    const xlsx = await admin.get('/reports/usage?from=2026-09-01&to=2026-10-31&format=xlsx');
    expect(xlsx.raw.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect((await jane.get('/reports/usage?from=2026-09-01&to=2026-10-31')).status).toBe(403);
  });
});

describe('emergencies and changing plans', () => {
  it('an urgent request alerts every admin by SMS and goes to the top of the queue', async () => {
    await book(tom, s.car2.id, inHours(1), inHours(2), [stop({ reasonId: s.errand.id, propertyId: null })]);
    const r = await jane.post('/bookings', {
      carId: s.car1.id,
      startAt: inHours(3).toISOString(),
      expectedReturnAt: inHours(4).toISOString(),
      stops: [stop({ reasonId: s.errand.id, propertyId: null, address: 'Pin at -1.30, 36.80', label: 'Dropped pin', lat: -1.3, lng: 36.8 })],
      urgent: true,
      notes: 'Burst pipe at a managed unit',
    });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('PENDING');
    expect(await prisma.notification.count({ where: { type: 'BOOKING_REQUESTED_URGENT', channel: 'SMS' } })).toBe(2);
    const approvals = await admin.get('/approvals');
    expect(approvals.body.bookings[0].id).toBe(r.body.id);
  });

  it('an admin books for a staff member and it is approved straight away', async () => {
    const r = await admin.post('/bookings', {
      carId: s.car1.id,
      startAt: inHours(2).toISOString(),
      expectedReturnAt: inHours(3).toISOString(),
      stops: [stop()],
      ownerId: s.jane.id,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'APPROVED', ownerId: s.jane.id, createdBy: { id: s.admin.id }, decidedBy: { id: s.admin.id } });
    expect(r.body.stops[0].addedBy.id).toBe(s.jane.id);
    expect(await prisma.notification.count({ where: { userId: s.jane.id, type: 'BOOKING_APPROVED', channel: 'IN_APP' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'BOOKING_CREATED_BY_ADMIN' } })).toBe(1);
    // Staff can't book for each other.
    const denied = await tom.post('/bookings', { carId: s.car2.id, startAt: inHours(5).toISOString(), expectedReturnAt: inHours(6).toISOString(), stops: [stop()], ownerId: s.jane.id });
    expect(denied.status).toBe(403);
    // And an on-behalf booking still can't double-book the driver.
    const clash = await admin.post('/bookings', { carId: s.car2.id, startAt: inHours(2).toISOString(), expectedReturnAt: inHours(3).toISOString(), stops: [stop()], ownerId: s.tom.id });
    expect(clash.status).toBe(409);
  });

  it('the trip owner adds and changes stops during the trip', async () => {
    const b = await approvedBookingStartedAgo(5);
    const { body } = await startTrip(b.id, 10_000);
    const tripId = body.trip.id;
    const before = (await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).plannedDistanceKm;

    const added = await jane.post(`/trips/${tripId}/stops`, { address: 'Emergency: Ngong Road', label: 'Call-out', lat: -1.3005, lng: 36.778, reasonId: s.errand.id });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ seq: 2, status: 'PLANNED' });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).plannedDistanceKm).not.toBe(before);

    const changed = await app.inject({
      method: 'PUT',
      url: `/trips/${tripId}/stops/${added.body.id}`,
      headers: { authorization: `Bearer ${jane.token}` },
      payload: { address: 'Karen shopping centre', lat: -1.3197, lng: 36.7076, reasonId: s.errand.id },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().address).toBe('Karen shopping centre');

    const events = await prisma.trackingEvent.findMany({ where: { tripId, type: { in: ['STOP_ADDED', 'STOP_CHANGED'] } } });
    expect(events.map((e) => e.type).sort()).toEqual(['STOP_ADDED', 'STOP_CHANGED']);
    expect(await prisma.notification.count({ where: { type: 'TRIP_STOPS_CHANGED', channel: 'IN_APP', userId: s.admin.id } })).toBe(2);

    // Viewings still need a property; passengers and others can't edit the route.
    expect((await jane.post(`/trips/${tripId}/stops`, { address: 'X', lat: -1.3, lng: 36.8, reasonId: s.viewing.id })).body.error.code).toBe('PROPERTY_REQUIRED');
    expect((await tom.post(`/trips/${tripId}/stops`, { address: 'X', lat: -1.3, lng: 36.8, reasonId: s.errand.id })).status).toBe(403);
  });
});
