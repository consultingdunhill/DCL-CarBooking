import {
  AdminCloseTripSchema,
  assertCanStartTrip,
  conflict,
  DeviceEventBatchSchema,
  DomainError,
  EndTripSchema,
  ExtendEtaSchema,
  fmtTime,
  forbidden,
  LocationBatchSchema,
  notFound,
  odometerVariancePct,
  pathDistanceKm,
  shortName,
  StartTripSchema,
  StopActionSchema,
  TripStopSchema,
  validateEndOdometer,
  validateStartOdometer,
} from '@carbooking/core';
import { isExclusionViolation, isUniqueViolation, prisma, type Prisma } from '@carbooking/db';
import { audit, auditView, env, getSettings, ingestDeviceEvents, ingestLocations, notify, publishLive, touchTrip } from '@carbooking/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isAdmin, me } from '../lib/auth';
import { ipOf, parse, type IdParams } from '../lib/http';
import { storage } from '../lib/storage';
import { signToken } from '../lib/tokens';
import { bookingInclude, conflictsFor, getOffice, prepareStops, replanBooking } from '../services/bookings';

const MINUTE = 60_000;

/** Device time for an action queued offline, if plausible; otherwise server time. */
function deviceTime(at: Date | undefined, now: Date): Date {
  if (!at) return now;
  if (at.getTime() > now.getTime() + 2 * MINUTE) return now;
  if (at.getTime() < now.getTime() - 12 * 60 * MINUTE) return now;
  return at;
}

/**
 * A token that only allows posting GPS and events for one trip. The
 * background plugin stores it, so it must not grant anything else.
 */
async function trackingConfig(trip: { id: string; trackingTokenVersion: number; bookingId: string }, userId: string) {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: trip.bookingId },
    include: { stops: { where: { status: { in: ['PLANNED', 'ARRIVED', 'DEPARTED'] } }, orderBy: { seq: 'asc' } }, trip: { select: { etaAt: true } } },
  });
  const office = await getOffice();
  const s = await getSettings();
  const eta = booking.trip?.etaAt ?? booking.expectedReturnAt;
  const expiresAt = new Date(Math.max(eta.getTime(), Date.now()) + 24 * 60 * MINUTE);
  return {
    token: await signToken('tracking', userId, expiresAt, { trip: trip.id, v: trip.trackingTokenVersion }),
    expiresAt,
    tripId: trip.id,
    locationsUrl: `${env.API_PUBLIC_URL}/tracking/locations`,
    eventsUrl: `${env.API_PUBLIC_URL}/tracking/events`,
    heartbeatUrl: `${env.API_PUBLIC_URL}/tracking/heartbeat`,
    office: { lat: office.lat, lng: office.lng, arrivalRadiusM: office.arrivalRadiusM, wakeupRadiusM: office.wakeupRadiusM },
    stops: booking.stops.map((st) => ({ id: st.id, seq: st.seq, lat: st.lat, lng: st.lng, address: st.address })),
    heartbeatIntervalMin: s.heartbeatIntervalMin,
    stopArrivalRadiusM: s.stopArrivalRadiusM,
    officeDwellMin: s.officeDwellMin,
    endPromptTimeoutMin: s.endPromptTimeoutMin,
    lowBatteryPct: s.lowBatteryPct,
  };
}

async function loadTripForOwner(req: FastifyRequest, tripId: string) {
  const user = me(req);
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { booking: { include: { car: true, owner: true } } } });
  if (!trip) throw notFound('Trip');
  if (trip.booking.ownerId !== user.id && !isAdmin(req)) throw forbidden('Only the trip owner can do that');
  return { user, trip };
}

async function notifyStopChange(trip: { id: string; booking: { car: { registration: string } } }, user: { id: string; name: string }, what: string) {
  await notify({
    to: { admins: true },
    exclude: [user.id],
    type: 'TRIP_STOPS_CHANGED',
    title: `Route changed: ${shortName(user.name)} (${trip.booking.car.registration})`,
    body: `${shortName(user.name)} ${what}.`,
    link: `/admin/trips/${trip.id}`,
    channels: ['IN_APP', 'PUSH'],
  });
}

const pointSelect = { recordedAt: true, lat: true, lng: true, accuracy: true, speed: true, battery: true, isMoving: true } satisfies Prisma.LocationPointSelect;

export async function tripRoutes(app: FastifyInstance) {
  // ── Start ───────────────────────────────────────────────────────────────────

  app.post<{ Params: IdParams }>('/bookings/:id/trip/start', async (req, reply) => {
    const user = me(req);
    const body = parse(StartTripSchema, req.body);
    const now = new Date();

    // Retried after being offline: return the trip already started.
    const existing = await prisma.trip.findUnique({ where: { startRequestId: body.clientRequestId } });
    if (existing) {
      if (existing.bookingId !== req.params.id) throw conflict('DUPLICATE_REQUEST', 'Request ID already used');
      return { trip: existing, tracking: await trackingConfig(existing, user.id) };
    }

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { car: true } });
    if (!booking) throw notFound('Booking');
    if (!user.privacyAckAt) throw new DomainError('PRIVACY_NOT_ACKNOWLEDGED', 'Read and accept the location privacy notice before starting a trip', 403);
    const s = await getSettings();
    const startedAt = deviceTime(body.startedAt, now);
    assertCanStartTrip(booking, user.id, startedAt, s);
    if (!(await storage.exists(body.photoKey)) || !body.photoKey.startsWith('odometer_start/')) {
      throw new DomainError('PHOTO_REQUIRED', 'Take a photo of the dashboard showing the odometer');
    }
    const { unloggedKm } = validateStartOdometer(body.odometer, booking.car.currentOdometer);

    let trip;
    try {
      trip = await prisma.$transaction(async (tx) => {
        const moved = await tx.booking.updateMany({ where: { id: booking.id, status: 'APPROVED' }, data: { status: 'IN_PROGRESS' } });
        if (moved.count === 0) throw conflict('NOT_APPROVED', 'This booking is no longer approved');
        const t = await tx.trip.create({
          data: {
            bookingId: booking.id,
            startedAt,
            odometerStart: body.odometer,
            photoStartKey: body.photoKey,
            unloggedKm,
            startRequestId: body.clientRequestId,
            device: (body.device ?? undefined) as Prisma.InputJsonValue | undefined,
            lastContactAt: now,
            trackingStatus: 'LIVE',
            trackingStatusSince: startedAt,
            etaAt: booking.expectedReturnAt,
          },
        });
        await tx.trackingEvent.create({
          data: { tripId: t.id, type: 'TRIP_STARTED', occurredAt: startedAt, source: 'DEVICE', details: { odometer: body.odometer, unloggedKm, device: body.device ?? null } },
        });
        await audit({ actorId: user.id, action: 'TRIP_STARTED', entity: 'Trip', entityId: t.id, after: { odometerStart: body.odometer, unloggedKm }, ip: ipOf(req) }, tx);
        return t;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const t = await prisma.trip.findUnique({ where: { bookingId: booking.id } });
        if (t) return { trip: t, tracking: await trackingConfig(t, user.id) };
      }
      throw err;
    }

    if (unloggedKm > 0) {
      await notify({
        to: { admins: true },
        type: 'UNLOGGED_KM',
        title: `${unloggedKm} unlogged km on ${booking.car.registration}`,
        body: `${shortName(user.name)} started at ${body.odometer} km; the last recorded reading was ${booking.car.currentOdometer} km.`,
        link: `/admin/trips/${trip.id}`,
        channels: ['IN_APP'],
      });
    }
    await publishLive({ type: 'booking.changed', bookingId: booking.id, status: 'IN_PROGRESS' });
    reply.code(201);
    return { trip, tracking: await trackingConfig(trip, user.id) };
  });

  app.post<{ Params: IdParams }>('/trips/:id/tracking-token', async (req) => {
    const { user, trip } = await loadTripForOwner(req, req.params.id);
    if (trip.booking.ownerId !== user.id) throw forbidden('Only the trip owner carries the tracking phone');
    if (trip.booking.status !== 'IN_PROGRESS') throw conflict('TRIP_NOT_RUNNING', 'Tracking only runs while the trip is in progress');
    return trackingConfig(trip, user.id);
  });

  // ── During ──────────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string; stopId: string } }>('/trips/:id/stops/:stopId', async (req) => {
    const { trip } = await loadTripForOwner(req, req.params.id);
    const body = parse(StopActionSchema, req.body);
    if (!['IN_PROGRESS', 'AWAITING_ODOMETER'].includes(trip.booking.status)) throw conflict('TRIP_NOT_RUNNING', 'The trip is not running');
    const stop = await prisma.bookingStop.findFirst({ where: { id: req.params.stopId, bookingId: trip.bookingId } });
    if (!stop) throw notFound('Stop');
    const at = deviceTime(body.at, new Date());
    const data: Prisma.BookingStopUpdateInput = { manualTimes: true };
    if (body.action === 'ARRIVED') Object.assign(data, { status: 'ARRIVED', arrivedAt: at, departedAt: null });
    else if (body.action === 'DEPARTED') Object.assign(data, { status: 'DEPARTED', departedAt: at, arrivedAt: stop.arrivedAt ?? at });
    else Object.assign(data, { status: 'SKIPPED' });
    const updated = await prisma.bookingStop.update({ where: { id: stop.id }, data });
    if (body.action !== 'SKIPPED') {
      await prisma.trackingEvent.create({
        data: {
          tripId: trip.id,
          type: body.action === 'ARRIVED' ? 'STOP_ARRIVED' : 'STOP_DEPARTED',
          occurredAt: at,
          source: 'DEVICE',
          lat: stop.lat,
          lng: stop.lng,
          details: { stopId: stop.id, seq: stop.seq, address: stop.address, manual: true },
        },
      });
    }
    await publishLive({ type: 'booking.changed', bookingId: trip.bookingId });
    return updated;
  });

  /** Plans change on the road: the trip owner adds a stop while the trip is running. */
  app.post<{ Params: IdParams }>('/trips/:id/stops', async (req, reply) => {
    const { user, trip } = await loadTripForOwner(req, req.params.id);
    if (trip.booking.status !== 'IN_PROGRESS') throw conflict('TRIP_NOT_RUNNING', 'Stops can only be added while the trip is running');
    const body = parse(TripStopSchema, req.body);
    const last = await prisma.bookingStop.aggregate({ where: { bookingId: trip.bookingId }, _max: { seq: true } });
    const [data] = await prepareStops([body], trip.booking.ownerId, (last._max.seq ?? 0) + 1);
    const stop = await prisma.bookingStop.create({ data: { ...data!, bookingId: trip.bookingId } });
    await prisma.trackingEvent.create({
      data: { tripId: trip.id, type: 'STOP_ADDED', occurredAt: new Date(), source: 'DEVICE', lat: stop.lat, lng: stop.lng, details: { stopId: stop.id, address: stop.address, by: user.name } },
    });
    await audit({ actorId: user.id, action: 'TRIP_STOP_ADDED', entity: 'BookingStop', entityId: stop.id, after: stop, ip: ipOf(req) });
    await replanBooking(trip.bookingId);
    await notifyStopChange(trip, user, `added a stop: ${stop.label ?? stop.address}`);
    await publishLive({ type: 'booking.changed', bookingId: trip.bookingId });
    reply.code(201);
    return stop;
  });

  /** Change where an upcoming stop is, or why (not once the car has arrived there). */
  app.put<{ Params: { id: string; stopId: string } }>('/trips/:id/stops/:stopId', async (req) => {
    const { user, trip } = await loadTripForOwner(req, req.params.id);
    if (trip.booking.status !== 'IN_PROGRESS') throw conflict('TRIP_NOT_RUNNING', 'Stops can only be changed while the trip is running');
    const before = await prisma.bookingStop.findFirst({ where: { id: req.params.stopId, bookingId: trip.bookingId } });
    if (!before) throw notFound('Stop');
    if (before.status !== 'PLANNED') throw conflict('STOP_VISITED', 'This stop has already been visited or skipped; add a new stop instead');
    const body = parse(TripStopSchema, req.body);
    const [data] = await prepareStops([body], before.addedById, before.seq);
    const stop = await prisma.bookingStop.update({ where: { id: before.id }, data: { ...data!, manualTimes: false, arrivedAt: null, departedAt: null } });
    await prisma.trackingEvent.create({
      data: {
        tripId: trip.id,
        type: 'STOP_CHANGED',
        occurredAt: new Date(),
        source: 'DEVICE',
        lat: stop.lat,
        lng: stop.lng,
        details: { stopId: stop.id, from: before.label ?? before.address, to: stop.label ?? stop.address, by: user.name },
      },
    });
    await audit({ actorId: user.id, action: 'TRIP_STOP_CHANGED', entity: 'BookingStop', entityId: stop.id, before, after: stop, ip: ipOf(req) });
    await replanBooking(trip.bookingId);
    await notifyStopChange(trip, user, `changed stop ${before.label ?? before.address} to ${stop.label ?? stop.address}`);
    await publishLive({ type: 'booking.changed', bookingId: trip.bookingId });
    return stop;
  });

  app.post<{ Params: IdParams }>('/trips/:id/extend', async (req) => {
    const { user, trip } = await loadTripForOwner(req, req.params.id);
    const { expectedReturnAt } = parse(ExtendEtaSchema, req.body);
    if (trip.booking.status !== 'IN_PROGRESS') throw conflict('TRIP_NOT_RUNNING', 'The trip is not running');
    const current = trip.etaAt ?? trip.booking.expectedReturnAt;
    if (expectedReturnAt <= current) throw new DomainError('INVALID_ETA', 'The new ETA must be later than the current one');
    if (expectedReturnAt.getTime() > trip.startedAt.getTime() + 24 * 60 * MINUTE) throw new DomainError('INVALID_ETA', 'A trip can’t run longer than 24 hours');

    const s = await getSettings();
    // The car is out either way, so the ETA always moves. If the booking's own
    // window can't move because the next trip holds the car or driver, tell them.
    await prisma.trip.update({ where: { id: trip.id }, data: { etaAt: expectedReturnAt, overdueNotifiedAt: null } });
    await prisma.trackingEvent.create({
      data: { tripId: trip.id, type: 'ETA_EXTENDED', occurredAt: new Date(), source: 'DEVICE', details: { from: current.toISOString(), to: expectedReturnAt.toISOString() } },
    });
    let clash = null;
    try {
      await prisma.booking.update({ where: { id: trip.bookingId }, data: { expectedReturnAt } });
    } catch (err) {
      if (!isExclusionViolation(err)) throw err;
      clash = await conflictsFor({ ...trip.booking, expectedReturnAt });
      const next = [...clash.car, ...clash.driver][0];
      const who = `${shortName(user.name)} (${trip.booking.car.registration})`;
      await notify({
        to: { userIds: [next?.owner.id], admins: true },
        exclude: [user.id],
        type: 'ETA_CLASH',
        title: 'A trip running late may delay yours',
        body: `${who} now expects to be back at ${fmtTime(expectedReturnAt, s.timezone)}, which overlaps ${next ? `${shortName(next.owner.name)}'s trip at ${fmtTime(new Date(next.startAt), s.timezone)}` : 'the next booking'}.`,
        link: next ? `/trips/${next.bookingId}` : '/admin/calendar',
      });
    }
    await publishLive({ type: 'booking.changed', bookingId: trip.bookingId });
    return { ok: true, etaAt: expectedReturnAt, clash };
  });

  // ── End ─────────────────────────────────────────────────────────────────────

  async function finish(
    tripId: string,
    opts: { odometer: number; photoKey: string | null; endedAt: Date; method: 'MANUAL' | 'GEOFENCE' | 'ADMIN'; requestId: string | null; note?: string; actorId: string; ip: string },
  ) {
    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId }, include: { booking: { include: { car: true } } } });
    const { tripKm } = validateEndOdometer(opts.odometer, trip.odometerStart);
    const s = await getSettings();
    const points = await prisma.locationPoint.findMany({ where: { tripId }, select: { lat: true, lng: true, recordedAt: true, accuracy: true } });
    const gpsKm = pathDistanceKm(points, { maxAccuracyM: s.maxFixAccuracyM });
    // If it went to AWAITING_ODOMETER, the trip really ended when the car got back.
    const endedAt = trip.officeArrivedAt && trip.booking.status === 'AWAITING_ODOMETER' ? trip.officeArrivedAt : opts.endedAt;

    await prisma.$transaction(async (tx) => {
      const moved = await tx.booking.updateMany({
        where: { id: trip.bookingId, status: { in: ['IN_PROGRESS', 'AWAITING_ODOMETER'] } },
        data: { status: 'COMPLETED' },
      });
      if (moved.count === 0) throw conflict('ALREADY_ENDED', 'This trip has already ended');
      await tx.trip.update({
        where: { id: tripId },
        data: {
          endedAt,
          odometerEnd: opts.odometer,
          photoEndKey: opts.photoKey,
          endMethod: opts.method,
          endNote: opts.note,
          endRequestId: opts.requestId,
          gpsDistanceKm: Math.round(gpsKm * 100) / 100,
          trackingStatus: 'STOPPED',
          trackingStatusSince: endedAt,
          locationOffSince: null,
        },
      });
      await tx.car.update({ where: { id: trip.booking.carId }, data: { currentOdometer: Math.max(trip.booking.car.currentOdometer, opts.odometer) } });
      await tx.trackingEvent.create({
        data: { tripId, type: 'TRIP_ENDED', occurredAt: endedAt, source: opts.method === 'ADMIN' ? 'SERVER' : 'DEVICE', details: { odometer: opts.odometer, method: opts.method, tripKm, gpsKm } },
      });
      await audit({ actorId: opts.actorId, action: opts.method === 'ADMIN' ? 'TRIP_CLOSED_BY_ADMIN' : 'TRIP_ENDED', entity: 'Trip', entityId: tripId, after: { odometerEnd: opts.odometer, tripKm, note: opts.note }, ip: opts.ip }, tx);
    });

    const variance = odometerVariancePct(tripKm, gpsKm);
    if (variance != null && variance > s.odometerVarianceThresholdPct && points.length > 10) {
      await notify({
        to: { admins: true },
        type: 'ODOMETER_VARIANCE',
        title: `Odometer vs GPS differ on ${trip.booking.car.registration}`,
        body: `Odometer ${tripKm} km, GPS ${gpsKm.toFixed(1)} km (${Math.round(variance)}% apart).`,
        link: `/admin/trips/${tripId}`,
        channels: ['IN_APP'],
      });
    }
    await publishLive({ type: 'booking.changed', bookingId: trip.bookingId, status: 'COMPLETED' });
    await publishLive({ type: 'trip.updated', tripId, bookingId: trip.bookingId, status: 'STOPPED' });
    return prisma.booking.findUniqueOrThrow({ where: { id: trip.bookingId }, include: bookingInclude });
  }

  app.post<{ Params: IdParams }>('/trips/:id/end', async (req) => {
    const user = me(req);
    const body = parse(EndTripSchema, req.body);
    const already = await prisma.trip.findUnique({ where: { endRequestId: body.clientRequestId } });
    if (already) return prisma.booking.findUniqueOrThrow({ where: { id: already.bookingId }, include: bookingInclude });

    const { trip } = await loadTripForOwner(req, req.params.id);
    if (trip.booking.ownerId !== user.id) throw forbidden('Only the trip owner ends the trip; admins can close it instead');
    if (!['IN_PROGRESS', 'AWAITING_ODOMETER'].includes(trip.booking.status)) throw conflict('ALREADY_ENDED', 'This trip has already ended');
    if (!body.photoKey.startsWith('odometer_end/') || !(await storage.exists(body.photoKey))) {
      throw new DomainError('PHOTO_REQUIRED', 'Take a photo of the dashboard showing the odometer');
    }
    const endedAt = deviceTime(body.endedAt, new Date());
    if (endedAt < trip.startedAt) throw new DomainError('INVALID_TIME', 'The end time is before the start');
    return finish(trip.id, { odometer: body.odometer, photoKey: body.photoKey, endedAt, method: body.method, requestId: body.clientRequestId, actorId: user.id, ip: ipOf(req) });
  });

  app.post<{ Params: IdParams }>('/trips/:id/admin-close', { config: { auth: 'admin' } }, async (req) => {
    const admin = me(req);
    const body = parse(AdminCloseTripSchema, req.body);
    const trip = await prisma.trip.findUnique({ where: { id: req.params.id }, include: { booking: true } });
    if (!trip) throw notFound('Trip');
    if (!['IN_PROGRESS', 'AWAITING_ODOMETER'].includes(trip.booking.status)) throw conflict('ALREADY_ENDED', 'This trip has already ended');
    const endedAt = body.endedAt ?? trip.officeArrivedAt ?? trip.lastSeenAt ?? new Date();
    const result = await finish(trip.id, { odometer: body.odometer, photoKey: body.photoKey ?? null, endedAt, method: 'ADMIN', requestId: null, note: body.note, actorId: admin.id, ip: ipOf(req) });
    await notify({
      to: { userIds: [trip.booking.ownerId] },
      type: 'TRIP_CLOSED_BY_ADMIN',
      title: 'Your trip was closed by an admin',
      body: `End reading recorded as ${body.odometer} km. ${body.note}`,
      link: `/trips/${trip.bookingId}`,
      channels: ['IN_APP'],
    });
    return result;
  });

  // ── Read ────────────────────────────────────────────────────────────────────

  /** My running trip, or my next approved one, for the home screen. */
  app.get('/me/current-trip', async (req) => {
    const user = me(req);
    const running = await prisma.booking.findFirst({
      where: { ownerId: user.id, status: { in: ['IN_PROGRESS', 'AWAITING_ODOMETER'] } },
      include: bookingInclude,
      orderBy: { startAt: 'asc' },
    });
    const next = await prisma.booking.findFirst({
      where: {
        status: 'APPROVED',
        expectedReturnAt: { gt: new Date() },
        OR: [{ ownerId: user.id }, { passengers: { some: { userId: user.id } } }],
      },
      include: bookingInclude,
      orderBy: { startAt: 'asc' },
    });
    return { running, next };
  });

  app.get<{ Params: IdParams }>('/trips/:id', async (req) => {
    const user = me(req);
    const trip = await prisma.trip.findUnique({
      where: { id: req.params.id },
      include: { booking: { include: bookingInclude }, events: { orderBy: { occurredAt: 'asc' } } },
    });
    if (!trip) throw notFound('Trip');
    const admin = isAdmin(req);
    const involved = trip.booking.ownerId === user.id || trip.booking.passengers.some((p) => p.userId === user.id);
    if (!admin && !involved) throw forbidden();

    const [photoStartUrl, photoEndUrl] = await Promise.all([
      storage.readUrl(trip.photoStartKey),
      trip.photoEndKey ? storage.readUrl(trip.photoEndKey) : Promise.resolve(null),
    ]);
    const tripKm = trip.odometerEnd != null ? trip.odometerEnd - trip.odometerStart : null;
    const s = await getSettings();
    const base = {
      ...trip,
      photoStartUrl,
      photoEndUrl,
      tripKm,
      variancePct: odometerVariancePct(tripKm, trip.gpsDistanceKm),
      varianceThresholdPct: s.odometerVarianceThresholdPct,
    };
    if (!admin) {
      // Staff see their trip, not the GPS record (location is admin-only).
      return {
        ...base,
        lastLat: null,
        lastLng: null,
        lastAddress: null,
        events: trip.events.filter((e) => ['TRIP_STARTED', 'TRIP_ENDED', 'STOP_ARRIVED', 'STOP_DEPARTED', 'ETA_EXTENDED', 'OVERDUE', 'AWAITING_ODOMETER'].includes(e.type)).map((e) => ({ ...e, lat: null, lng: null })),
        points: [],
      };
    }
    const points = await prisma.locationPoint.findMany({ where: { tripId: trip.id }, orderBy: { recordedAt: 'asc' }, select: pointSelect });
    await auditView({ actorId: user.id, action: 'VIEW_LOCATION', entity: 'Trip', entityId: trip.id, ip: ipOf(req) });
    return { ...base, points };
  });

  app.get<{ Querystring: { from?: string; to?: string; carId?: string; status?: string } }>('/admin/trips', { config: { auth: 'admin' } }, async (req) => {
    const where: Prisma.TripWhereInput = {};
    if (req.query.from || req.query.to) {
      where.startedAt = { ...(req.query.from ? { gte: new Date(req.query.from) } : {}), ...(req.query.to ? { lt: new Date(req.query.to) } : {}) };
    }
    if (req.query.carId) where.booking = { carId: req.query.carId };
    if (req.query.status) where.booking = { ...(where.booking as object), status: { in: req.query.status.split(',') as never } };
    const trips = await prisma.trip.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: 300,
      include: {
        booking: {
          select: {
            id: true,
            status: true,
            startAt: true,
            expectedReturnAt: true,
            owner: { select: { id: true, name: true } },
            car: { select: { id: true, registration: true } },
            stops: { where: { status: { in: ['PLANNED', 'ARRIVED', 'DEPARTED', 'SKIPPED'] } }, select: { id: true, address: true, label: true }, orderBy: { seq: 'asc' } },
          },
        },
        _count: { select: { events: { where: { type: { in: ['LOCATION_OFF', 'TRACKING_LOST', 'OVERDUE'] } } } } },
      },
    });
    const s = await getSettings();
    return trips.map((t) => {
      const tripKm = t.odometerEnd != null ? t.odometerEnd - t.odometerStart : null;
      const variancePct = odometerVariancePct(tripKm, t.gpsDistanceKm);
      return { ...t, tripKm, variancePct, varianceFlag: variancePct != null && variancePct > s.odometerVarianceThresholdPct, issues: t._count.events };
    });
  });

  // ── Tracking ingest (trip-scoped token) ─────────────────────────────────────

  const trackingTrip = async (req: FastifyRequest) => {
    const t = req.tracking!;
    const trip = await prisma.trip.findUnique({ where: { id: t.tripId }, select: { id: true, booking: { select: { ownerId: true, status: true } } } });
    if (!trip || trip.booking.ownerId !== t.userId) throw new DomainError('TRACKING_TOKEN_INVALID', 'Unknown trip', 401);
    return trip;
  };

  // Transistorsoft's HTTP sync posts {"location": [...]} with batchSync.
  app.post('/tracking/locations', { config: { auth: 'tracking' }, bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const trip = await trackingTrip(req);
    const body = parse(LocationBatchSchema, req.body);
    const list = Array.isArray(body.location) ? body.location : [body.location];
    const result = await ingestLocations(trip.id, list);
    // Tell the app to stop tracking once the trip is over.
    const status = (await prisma.booking.findFirst({ where: { trip: { id: trip.id } }, select: { status: true } }))?.status;
    return { ...result, tripStatus: status, stopTracking: status !== 'IN_PROGRESS' };
  });

  app.post('/tracking/events', { config: { auth: 'tracking' } }, async (req) => {
    const trip = await trackingTrip(req);
    const body = parse(DeviceEventBatchSchema, req.body);
    return ingestDeviceEvents(trip.id, body.events);
  });

  app.post('/tracking/heartbeat', { config: { auth: 'tracking' } }, async (req) => {
    const trip = await trackingTrip(req);
    await touchTrip(trip.id);
    return { tripStatus: trip.booking.status, stopTracking: trip.booking.status !== 'IN_PROGRESS' };
  });
}
