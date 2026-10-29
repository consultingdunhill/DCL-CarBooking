import {
  ApproveBookingSchema,
  assertJoinTransition,
  assertTransition,
  AvailabilityQuerySchema,
  BookingListQuerySchema,
  CancelSchema,
  conflict,
  CreateBookingSchema,
  DomainError,
  fmtDateTime,
  fmtTime,
  fmtWhen,
  fmtWindow,
  forbidden,
  JOINABLE_STATUSES,
  JoinRequestSchema,
  notFound,
  RejectSchema,
  RoutePreviewSchema,
  shortName,
  validateBookingWindow,
  type BookingStatus,
} from '@carbooking/core';
import { isExclusionViolation, prisma, type Prisma } from '@carbooking/db';
import { audit, cancelPendingJoins, getSettings, notify, notifyJoinsCancelled, publishLive } from '@carbooking/server';
import type { FastifyInstance } from 'fastify';
import { isAdmin, me } from '../lib/auth';
import { ipOf, parse, type IdParams } from '../lib/http';
import { previewRoute } from '../lib/maps';
import { availability, bookingInclude, conflictsFor, planRoute, prepareStops, redactForStaff, replanBooking } from '../services/bookings';

const slotTaken = (details?: unknown) =>
  conflict('SLOT_TAKEN', 'Another approved trip already holds this car or the driver at that time. Choose another car or time.', details);

export async function bookingRoutes(app: FastifyInstance) {
  // ── Availability & route preview ────────────────────────────────────────────

  app.get('/bookings/availability', async (req) => {
    const q = parse(AvailabilityQuerySchema, req.query);
    if (!(q.end > q.start)) throw new DomainError('INVALID_WINDOW', 'The return time must be after the start time');
    return availability(q.start, q.end, q.excludeBookingId);
  });

  app.post('/routes/preview', async (req) => {
    const body = parse(RoutePreviewSchema, req.body);
    return previewRoute([body.origin, ...body.stops, ...(body.returnToOrigin ? [body.origin] : [])]);
  });

  // ── Create ──────────────────────────────────────────────────────────────────

  app.post('/bookings', async (req, reply) => {
    const user = me(req);
    const body = parse(CreateBookingSchema, req.body);
    validateBookingWindow(body.startAt, body.expectedReturnAt, new Date());

    // An admin can book on a staff member's behalf (e.g. after a phone call in an
    // emergency). That booking is the admin's decision, so it is approved straight away.
    const onBehalf = Boolean(body.ownerId && body.ownerId !== user.id);
    if (onBehalf && !isAdmin(req)) throw forbidden('Only admins can book for someone else');
    const owner = onBehalf ? await prisma.user.findUnique({ where: { id: body.ownerId } }) : user;
    if (!owner || !owner.active) throw notFound('Staff member');

    const car = await prisma.car.findUnique({ where: { id: body.carId } });
    if (!car) throw notFound('Car');
    if (car.status !== 'AVAILABLE') throw conflict('CAR_UNAVAILABLE', `${car.registration} is ${car.status === 'MAINTENANCE' ? 'in maintenance' : 'not in service'}`);

    const avail = await availability(body.startAt, body.expectedReturnAt);
    if (avail.driver.noDriverConfigured) throw conflict('NO_DRIVER', 'No driver is set up yet. Ask an admin to add the driver.');
    if (!avail.driver.available) throw conflict('DRIVER_BUSY', avail.driver.busyWith[0]?.description ?? 'The driver is out at that time', { availability: avail });
    const carSlot = avail.cars.find((c) => c.car.id === car.id);
    if (!carSlot?.available) throw conflict('CAR_BOOKED', `${car.registration} is already booked at that time`, { availability: avail });

    // Stops are credited to the staff member the trip is for.
    const stops = await prepareStops(body.stops, owner.id, 1);
    const route = await planRoute(body.stops);
    const now = new Date();
    let booking;
    try {
      booking = await prisma.$transaction(async (tx) => {
        const b = await tx.booking.create({
          data: {
            ownerId: owner.id,
            driverId: avail.driver.driverId!,
            carId: car.id,
            startAt: body.startAt,
            expectedReturnAt: body.expectedReturnAt,
            reasonId: stops[0]!.reasonId,
            notes: body.notes,
            urgent: body.urgent,
            createdById: onBehalf ? user.id : null,
            plannedDistanceKm: route.distanceKm,
            plannedDurationMin: route.durationMin,
            plannedPolyline: route.polyline,
            ...(onBehalf ? { status: 'APPROVED' as const, decidedById: user.id, decidedAt: now } : {}),
            stops: { createMany: { data: stops } },
          },
          include: bookingInclude,
        });
        await audit(
          {
            actorId: user.id,
            action: onBehalf ? 'BOOKING_CREATED_BY_ADMIN' : 'BOOKING_CREATED',
            entity: 'Booking',
            entityId: b.id,
            after: { status: b.status, ownerId: owner.id, urgent: body.urgent },
            ip: ipOf(req),
          },
          tx,
        );
        return b;
      });
    } catch (err) {
      if (isExclusionViolation(err)) throw slotTaken();
      throw err;
    }

    const { timezone } = await getSettings();
    const when = fmtWhen(booking.startAt, booking.expectedReturnAt, timezone);
    if (onBehalf) {
      await notify({
        to: { userIds: [owner.id] },
        type: 'BOOKING_APPROVED',
        title: `${shortName(user.name)} booked a trip for you`,
        body: `${car.registration}, ${when}. It's approved; start it from the app when you're ready.`,
        link: `/trips/${booking.id}`,
        urgent: body.urgent,
      });
      await notify({
        to: { admins: true },
        exclude: [user.id],
        type: 'BOOKING_CREATED_BY_ADMIN',
        title: `${shortName(user.name)} booked ${car.registration} for ${shortName(owner.name)}`,
        body: `${when}. Approved straight away.`,
        link: `/trips/${booking.id}`,
        channels: ['IN_APP'],
      });
    } else {
      await notify({
        to: { admins: true },
        exclude: [user.id],
        type: body.urgent ? 'BOOKING_REQUESTED_URGENT' : 'BOOKING_REQUESTED',
        title: `${body.urgent ? 'URGENT trip request' : 'Trip request'} from ${shortName(user.name)}`,
        body: `${car.registration}, ${when}, ${booking.stops.length} stop(s).${body.urgent && body.notes ? ` ${body.notes}` : ''}`,
        link: `/admin/approvals`,
        urgent: body.urgent,
      });
    }
    await publishLive({ type: 'booking.changed', bookingId: booking.id, status: booking.status });
    reply.code(201);
    return booking;
  });

  // ── Read ────────────────────────────────────────────────────────────────────

  app.get('/bookings', async (req) => {
    const user = me(req);
    const q = parse(BookingListQuerySchema, req.query);
    const statuses = q.status?.split(',').filter(Boolean) as BookingStatus[] | undefined;
    let where: Prisma.BookingWhereInput = {};
    if (q.scope === 'mine') {
      where = {
        OR: [{ ownerId: user.id }, { passengers: { some: { userId: user.id } } }, { joinRequests: { some: { requesterId: user.id, status: 'PENDING' } } }],
      };
    } else if (q.scope === 'calendar') {
      // Everyone can see who holds which slot.
      where = { status: { in: ['PENDING', 'APPROVED', 'IN_PROGRESS', 'AWAITING_ODOMETER', 'COMPLETED'] } };
    } else {
      if (!isAdmin(req)) throw forbidden();
      if (q.scope === 'approvals') where = { status: 'PENDING' };
    }
    if (statuses?.length) where = { AND: [where, { status: { in: statuses } }] };
    if (q.from || q.to) {
      where = {
        AND: [where, { ...(q.to ? { startAt: { lt: q.to } } : {}), ...(q.from ? { expectedReturnAt: { gt: q.from } } : {}) }],
      };
    }
    const rows = await prisma.booking.findMany({
      where,
      include: bookingInclude,
      orderBy: { startAt: q.scope === 'mine' ? 'desc' : 'asc' },
      take: 500,
    });
    return rows.map((b) => redactForStaff(b, user));
  });

  app.get<{ Params: IdParams }>('/bookings/:id', async (req) => {
    const user = me(req);
    const b = await prisma.booking.findUnique({ where: { id: req.params.id }, include: bookingInclude });
    if (!b) throw notFound('Booking');
    return redactForStaff(b, user);
  });

  app.get<{ Params: IdParams; Querystring: { carId?: string; driverId?: string; returnAt?: string } }>(
    '/bookings/:id/conflicts',
    { config: { auth: 'admin' } },
    async (req) => {
      const b = await prisma.booking.findUnique({ where: { id: req.params.id } });
      if (!b) throw notFound('Booking');
      return conflictsFor({
        id: b.id,
        startAt: b.startAt,
        expectedReturnAt: req.query.returnAt ? new Date(req.query.returnAt) : b.expectedReturnAt,
        carId: req.query.carId ?? b.carId,
        driverId: req.query.driverId ?? b.driverId,
      });
    },
  );

  // ── Admin decisions ─────────────────────────────────────────────────────────

  app.get('/approvals', { config: { auth: 'admin' } }, async () => {
    const [bookings, joins] = await Promise.all([
      prisma.booking.findMany({ where: { status: 'PENDING' }, include: bookingInclude, orderBy: [{ urgent: 'desc' }, { startAt: 'asc' }] }),
      prisma.joinRequest.findMany({
        where: { status: 'PENDING' },
        include: {
          requester: { select: { id: true, name: true, phone: true, email: true, department: true } },
          booking: { include: bookingInclude },
          stops: { orderBy: { seq: 'asc' }, include: { reason: true, property: { select: { id: true, ref: true, address: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      bookings: await Promise.all(bookings.map(async (b) => ({ ...b, conflicts: await conflictsFor(b) }))),
      joinRequests: await Promise.all(
        joins.map(async (j) => ({
          ...j,
          clash:
            j.proposedReturnAt && j.proposedReturnAt > j.booking.expectedReturnAt
              ? await conflictsFor({ ...j.booking, expectedReturnAt: j.proposedReturnAt })
              : null,
        })),
      ),
    };
  });

  app.post<{ Params: IdParams }>('/bookings/:id/approve', { config: { auth: 'admin' } }, async (req) => {
    const admin = me(req);
    const body = parse(ApproveBookingSchema, req.body);
    const before = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { car: true } });
    if (!before) throw notFound('Booking');
    assertTransition(before.status, 'APPROVED');

    const carId = body.carId ?? before.carId;
    const driverId = body.driverId ?? before.driverId;
    if (carId !== before.carId) {
      const car = await prisma.car.findUnique({ where: { id: carId } });
      if (!car || car.status !== 'AVAILABLE') throw conflict('CAR_UNAVAILABLE', 'That car is not available');
    }
    if (driverId !== before.driverId && !(await prisma.driver.findFirst({ where: { id: driverId, active: true } }))) {
      throw notFound('Driver');
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Only a still-pending booking can be approved: a second admin gets "already decided".
        const r = await tx.booking.updateMany({
          where: { id: before.id, status: 'PENDING' },
          data: { status: 'APPROVED', carId, driverId, decidedById: admin.id, decidedAt: new Date() },
        });
        if (r.count === 0) throw conflict('ALREADY_DECIDED', 'Another admin has already decided this request');
        await audit(
          {
            actorId: admin.id,
            action: carId !== before.carId ? 'BOOKING_REASSIGNED_APPROVED' : 'BOOKING_APPROVED',
            entity: 'Booking',
            entityId: before.id,
            before: { status: before.status, carId: before.carId, driverId: before.driverId },
            after: { status: 'APPROVED', carId, driverId, note: body.note },
            ip: ipOf(req),
          },
          tx,
        );
      });
    } catch (err) {
      // The database exclusion constraints are the last line of defence against double booking.
      if (isExclusionViolation(err)) throw slotTaken(await conflictsFor({ ...before, carId, driverId }));
      throw err;
    }

    const b = await prisma.booking.findUniqueOrThrow({ where: { id: before.id }, include: bookingInclude });
    const { timezone } = await getSettings();
    await notify({
      to: { userIds: [b.ownerId] },
      type: 'BOOKING_APPROVED',
      title: 'Trip approved',
      body: `${b.car.registration}, ${fmtDateTime(b.startAt, timezone)}.${carId !== before.carId ? ` The car was changed from ${before.car.registration}.` : ''}${body.note ? ` Note: ${body.note}` : ''}`,
      link: `/trips/${b.id}`,
    });
    await publishLive({ type: 'booking.changed', bookingId: b.id, status: b.status });
    return b;
  });

  app.post<{ Params: IdParams }>('/bookings/:id/reject', { config: { auth: 'admin' } }, async (req) => {
    const admin = me(req);
    const { reason } = parse(RejectSchema, req.body);
    const before = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { owner: true } });
    if (!before) throw notFound('Booking');
    assertTransition(before.status, 'REJECTED');
    const joins = await prisma.$transaction(async (tx) => {
      const r = await tx.booking.updateMany({
        where: { id: before.id, status: 'PENDING' },
        data: { status: 'REJECTED', rejectionReason: reason, decidedById: admin.id, decidedAt: new Date() },
      });
      if (r.count === 0) throw conflict('ALREADY_DECIDED', 'Another admin has already decided this request');
      await audit({ actorId: admin.id, action: 'BOOKING_REJECTED', entity: 'Booking', entityId: before.id, before: { status: before.status }, after: { status: 'REJECTED', reason }, ip: ipOf(req) }, tx);
      return cancelPendingJoins(tx, before.id);
    });
    const { timezone } = await getSettings();
    await notify({
      to: { userIds: [before.ownerId] },
      type: 'BOOKING_REJECTED',
      title: 'Trip request rejected',
      body: `Your trip on ${fmtDateTime(before.startAt, timezone)} was rejected: ${reason}`,
      link: `/trips/${before.id}`,
    });
    await notifyJoinsCancelled(joins, before, 'rejected');
    await publishLive({ type: 'booking.changed', bookingId: before.id, status: 'REJECTED' });
    return prisma.booking.findUniqueOrThrow({ where: { id: before.id }, include: bookingInclude });
  });

  app.post<{ Params: IdParams }>('/bookings/:id/cancel', async (req) => {
    const user = me(req);
    const { reason } = parse(CancelSchema, req.body);
    const before = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { owner: true, car: true } });
    if (!before) throw notFound('Booking');
    if (before.ownerId !== user.id && !isAdmin(req)) throw forbidden('Only the trip owner or an admin can cancel');
    assertTransition(before.status, 'CANCELLED');
    const joins = await prisma.$transaction(async (tx) => {
      const r = await tx.booking.updateMany({
        where: { id: before.id, status: before.status },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
      });
      if (r.count === 0) throw conflict('STALE', 'This booking changed in the meantime. Refresh and try again.');
      await audit({ actorId: user.id, action: 'BOOKING_CANCELLED', entity: 'Booking', entityId: before.id, before: { status: before.status }, after: { status: 'CANCELLED', reason }, ip: ipOf(req) }, tx);
      return cancelPendingJoins(tx, before.id);
    });
    const { timezone } = await getSettings();
    const passengers = await prisma.bookingPassenger.findMany({ where: { bookingId: before.id }, select: { userId: true } });
    await notify({
      to: { userIds: [before.ownerId, ...passengers.map((p) => p.userId)], admins: before.status === 'APPROVED' },
      exclude: [user.id],
      type: 'BOOKING_CANCELLED',
      title: 'Trip cancelled',
      body: `${shortName(before.owner.name)}'s trip in ${before.car.registration} on ${fmtDateTime(before.startAt, timezone)} was cancelled${reason ? `: ${reason}` : ''}.`,
      link: `/trips/${before.id}`,
      channels: ['IN_APP', 'PUSH'],
    });
    await notifyJoinsCancelled(joins, before, 'cancelled');
    await publishLive({ type: 'booking.changed', bookingId: before.id, status: 'CANCELLED' });
    return prisma.booking.findUniqueOrThrow({ where: { id: before.id }, include: bookingInclude });
  });

  // ── Joining someone else's trip ─────────────────────────────────────────────

  app.post<{ Params: IdParams }>('/bookings/:id/join-requests', async (req, reply) => {
    const user = me(req);
    const body = parse(JoinRequestSchema, req.body);
    const b = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { owner: true, passengers: true, stops: true } });
    if (!b) throw notFound('Booking');
    if (!(JOINABLE_STATUSES as string[]).includes(b.status)) throw conflict('NOT_JOINABLE', 'This trip can no longer take extra stops');
    if (b.ownerId === user.id) throw conflict('OWN_TRIP', 'This is your own trip. Edit it instead.');
    if (b.passengers.some((p) => p.userId === user.id)) throw conflict('ALREADY_ON_TRIP', "You're already a passenger on this trip");
    if (body.proposedReturnAt && body.proposedReturnAt <= b.startAt) {
      throw new DomainError('INVALID_WINDOW', 'The return time must be after the trip starts');
    }
    const existing = await prisma.joinRequest.count({ where: { bookingId: b.id, requesterId: user.id, status: 'PENDING' } });
    if (existing) throw conflict('ALREADY_REQUESTED', 'You already have a pending request on this trip');

    const startSeq = Math.max(0, ...b.stops.map((s) => s.seq)) + 1;
    const stops = await prepareStops(body.stops, user.id, startSeq, { status: 'PROPOSED' });
    const join = await prisma.joinRequest.create({
      data: {
        bookingId: b.id,
        requesterId: user.id,
        reasonId: stops[0]!.reasonId,
        note: body.note,
        proposedReturnAt: body.proposedReturnAt && body.proposedReturnAt > b.expectedReturnAt ? body.proposedReturnAt : null,
        stops: { createMany: { data: stops.map((s) => ({ ...s, bookingId: b.id })) } },
      },
      include: { stops: true },
    });
    await audit({ actorId: user.id, action: 'JOIN_REQUESTED', entity: 'JoinRequest', entityId: join.id, after: { bookingId: b.id }, ip: ipOf(req) });

    const { timezone } = await getSettings();
    const where = stops.map((s) => s.label ?? s.address).join(', ');
    // The trip owner is told for information; the admins decide.
    await notify({
      to: { userIds: [b.ownerId] },
      type: 'JOIN_REQUESTED_OWNER',
      title: `${shortName(user.name)} asked to join your trip`,
      body: `They'd like to add a stop at ${where}. An admin will approve or reject it; your booking stays approved.`,
      link: `/trips/${b.id}`,
      channels: ['IN_APP', 'PUSH'],
    });
    await notify({
      to: { admins: true },
      exclude: [user.id],
      type: 'JOIN_REQUESTED',
      title: `Join request from ${shortName(user.name)}`,
      body: `Add a stop at ${where} to ${shortName(b.owner.name)}'s trip (${fmtWindow(b.startAt, b.expectedReturnAt, timezone)}).`,
      link: '/admin/approvals',
    });
    await publishLive({ type: 'join.changed', joinRequestId: join.id, bookingId: b.id, status: 'PENDING' });
    reply.code(201);
    return join;
  });

  app.post<{ Params: IdParams }>('/join-requests/:id/approve', { config: { auth: 'admin' } }, async (req) => {
    const admin = me(req);
    const j = await prisma.joinRequest.findUnique({ where: { id: req.params.id }, include: { booking: { include: { owner: true } }, requester: true } });
    if (!j) throw notFound('Join request');
    assertJoinTransition(j.status, 'APPROVED');
    if (!(JOINABLE_STATUSES as string[]).includes(j.booking.status)) throw conflict('NOT_JOINABLE', 'The trip can no longer take extra stops');

    try {
      await prisma.$transaction(async (tx) => {
        const r = await tx.joinRequest.updateMany({ where: { id: j.id, status: 'PENDING' }, data: { status: 'APPROVED', decidedById: admin.id, decidedAt: new Date() } });
        if (r.count === 0) throw conflict('ALREADY_DECIDED', 'Another admin has already decided this request');
        // Proposed stops join the route, after the existing ones.
        const existing = await tx.bookingStop.findMany({ where: { bookingId: j.bookingId, status: { notIn: ['PROPOSED', 'REJECTED'] } }, select: { seq: true } });
        let seq = Math.max(0, ...existing.map((s) => s.seq));
        const proposed = await tx.bookingStop.findMany({ where: { joinRequestId: j.id, status: 'PROPOSED' }, orderBy: { seq: 'asc' } });
        for (const s of proposed) await tx.bookingStop.update({ where: { id: s.id }, data: { status: 'PLANNED', seq: ++seq } });
        await tx.bookingPassenger.upsert({
          where: { bookingId_userId: { bookingId: j.bookingId, userId: j.requesterId } },
          create: { bookingId: j.bookingId, userId: j.requesterId, joinRequestId: j.id },
          update: {},
        });
        if (j.proposedReturnAt && j.proposedReturnAt > j.booking.expectedReturnAt) {
          await tx.booking.update({ where: { id: j.bookingId }, data: { expectedReturnAt: j.proposedReturnAt } });
          await tx.trip.updateMany({ where: { bookingId: j.bookingId }, data: { etaAt: j.proposedReturnAt } });
        }
        await audit({ actorId: admin.id, action: 'JOIN_APPROVED', entity: 'JoinRequest', entityId: j.id, after: { bookingId: j.bookingId, proposedReturnAt: j.proposedReturnAt }, ip: ipOf(req) }, tx);
      });
    } catch (err) {
      if (isExclusionViolation(err)) {
        throw slotTaken(await conflictsFor({ ...j.booking, expectedReturnAt: j.proposedReturnAt ?? j.booking.expectedReturnAt }));
      }
      throw err;
    }
    await replanBooking(j.bookingId);

    const { timezone } = await getSettings();
    await notify({
      to: { userIds: [j.requesterId] },
      type: 'JOIN_APPROVED',
      title: 'You can join the trip',
      body: `Your stop was added to ${shortName(j.booking.owner.name)}'s trip, ${fmtWindow(j.booking.startAt, j.proposedReturnAt ?? j.booking.expectedReturnAt, timezone)}. Be at the office for the start.`,
      link: `/trips/${j.bookingId}`,
    });
    await notify({
      to: { userIds: [j.booking.ownerId] },
      type: 'JOIN_APPROVED_OWNER',
      title: `${shortName(j.requester.name)} is joining your trip`,
      body: `Their stop was added to your route${j.proposedReturnAt ? ` and the return time moved to ${fmtTime(j.proposedReturnAt, timezone)}` : ''}.`,
      link: `/trips/${j.bookingId}`,
      channels: ['IN_APP', 'PUSH'],
    });
    await publishLive({ type: 'join.changed', joinRequestId: j.id, bookingId: j.bookingId, status: 'APPROVED' });
    await publishLive({ type: 'booking.changed', bookingId: j.bookingId });
    return prisma.booking.findUniqueOrThrow({ where: { id: j.bookingId }, include: bookingInclude });
  });

  app.post<{ Params: IdParams }>('/join-requests/:id/reject', { config: { auth: 'admin' } }, async (req) => {
    const admin = me(req);
    const { reason } = parse(RejectSchema, req.body);
    const j = await prisma.joinRequest.findUnique({ where: { id: req.params.id } });
    if (!j) throw notFound('Join request');
    assertJoinTransition(j.status, 'REJECTED');
    await prisma.$transaction(async (tx) => {
      const r = await tx.joinRequest.updateMany({
        where: { id: j.id, status: 'PENDING' },
        data: { status: 'REJECTED', rejectionReason: reason, decidedById: admin.id, decidedAt: new Date() },
      });
      if (r.count === 0) throw conflict('ALREADY_DECIDED', 'Another admin has already decided this request');
      await tx.bookingStop.updateMany({ where: { joinRequestId: j.id, status: 'PROPOSED' }, data: { status: 'REJECTED' } });
      await audit({ actorId: admin.id, action: 'JOIN_REJECTED', entity: 'JoinRequest', entityId: j.id, after: { reason }, ip: ipOf(req) }, tx);
    });
    await notify({
      to: { userIds: [j.requesterId] },
      type: 'JOIN_REJECTED',
      title: 'Request to join the trip rejected',
      body: reason,
      link: `/trips/${j.bookingId}`,
    });
    await publishLive({ type: 'join.changed', joinRequestId: j.id, bookingId: j.bookingId, status: 'REJECTED' });
    return { ok: true };
  });

  app.post<{ Params: IdParams }>('/join-requests/:id/cancel', async (req) => {
    const user = me(req);
    const j = await prisma.joinRequest.findUnique({ where: { id: req.params.id } });
    if (!j) throw notFound('Join request');
    if (j.requesterId !== user.id) throw forbidden();
    assertJoinTransition(j.status, 'CANCELLED');
    await prisma.$transaction([
      prisma.joinRequest.update({ where: { id: j.id }, data: { status: 'CANCELLED', decidedAt: new Date() } }),
      prisma.bookingStop.updateMany({ where: { joinRequestId: j.id, status: 'PROPOSED' }, data: { status: 'REJECTED' } }),
    ]);
    await publishLive({ type: 'join.changed', joinRequestId: j.id, bookingId: j.bookingId, status: 'CANCELLED' });
    return { ok: true };
  });
}
