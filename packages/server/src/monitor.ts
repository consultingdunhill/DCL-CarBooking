import { fmtTime, isNoShow, shortName } from '@carbooking/core';
import { prisma } from '@carbooking/db';
import { audit } from './audit';
import { cancelPendingJoins, notifyJoinsCancelled } from './bookings';
import { dispatchNotifications } from './channels';
import { publishLive } from './live';
import { notify } from './notify';
import { getSettings } from './settings';
import { refreshTrackingStatus } from './tracking';

const MINUTE = 60_000;

/**
 * Heartbeat monitor: no contact for 5+ minutes → Offline; much longer, or
 * with a dying battery → Tracking lost. Also moves trips that reached the
 * office but weren't ended to AWAITING_ODOMETER.
 */
export async function runTrackingMonitor(now = new Date()) {
  const s = await getSettings();
  const running = await prisma.trip.findMany({
    where: { booking: { status: 'IN_PROGRESS' } },
    select: { id: true, officeArrivedAt: true, bookingId: true, booking: { select: { ownerId: true, owner: { select: { name: true } }, car: { select: { registration: true } } } } },
  });
  for (const t of running) {
    await refreshTrackingStatus(t.id, now);

    if (t.officeArrivedAt && now.getTime() - t.officeArrivedAt.getTime() > s.endPromptTimeoutMin * MINUTE) {
      const moved = await prisma.booking.updateMany({ where: { id: t.bookingId, status: 'IN_PROGRESS' }, data: { status: 'AWAITING_ODOMETER' } });
      if (moved.count === 0) continue;
      await prisma.trip.update({
        where: { id: t.id },
        data: { trackingStatus: 'STOPPED', trackingStatusSince: now, awaitingOdometerAt: now, lastReminderAt: now },
      });
      await prisma.trackingEvent.create({ data: { tripId: t.id, type: 'AWAITING_ODOMETER', occurredAt: now, source: 'SERVER' } });
      await notify({
        to: { userIds: [t.booking.ownerId], admins: true },
        type: 'AWAITING_ODOMETER',
        title: 'Enter the end odometer reading',
        body: `${shortName(t.booking.owner.name)}'s trip in ${t.booking.car.registration} is back at the office but wasn't ended. Tracking has stopped; enter the odometer reading to close it.`,
        link: `/trips/${t.bookingId}?end=1`,
        channels: ['IN_APP', 'PUSH'],
      });
      await publishLive({ type: 'booking.changed', bookingId: t.bookingId, status: 'AWAITING_ODOMETER' });
    }
  }
}

/**
 * Overdue: past the ETA plus the grace period, push the trip owner; if still
 * out after a second grace period, escalate to admins by push and SMS/WhatsApp.
 */
export async function runOverdueCheck(now = new Date()) {
  const s = await getSettings();
  const grace = s.overdueGraceMin * MINUTE;
  const trips = await prisma.trip.findMany({
    where: { booking: { status: 'IN_PROGRESS' } },
    include: {
      booking: { include: { owner: { select: { id: true, name: true, phone: true } }, car: { select: { registration: true } } } },
      events: { where: { type: 'OVERDUE' }, select: { details: true } },
    },
  });
  for (const t of trips) {
    const eta = t.etaAt ?? t.booking.expectedReturnAt;
    const late = now.getTime() - eta.getTime();
    const stages = new Set(t.events.map((e) => (e.details as { stage?: string } | null)?.stage));
    const who = `${shortName(t.booking.owner.name)} (${t.booking.car.registration})`;

    if (late > grace && !stages.has('owner')) {
      await prisma.trackingEvent.create({ data: { tripId: t.id, type: 'OVERDUE', occurredAt: now, source: 'SERVER', details: { stage: 'owner', eta: eta.toISOString() } } });
      await prisma.trip.update({ where: { id: t.id }, data: { overdueNotifiedAt: now } });
      await notify({
        to: { userIds: [t.booking.ownerId] },
        type: 'OVERDUE',
        title: 'Your trip is overdue',
        body: `The car was due back at ${fmtTime(eta, s.timezone)}. Head back, or extend your ETA in the app.`,
        link: `/trips/${t.bookingId}`,
        channels: ['IN_APP', 'PUSH'],
      });
    }
    if (late > 2 * grace && !stages.has('admin')) {
      await prisma.trackingEvent.create({ data: { tripId: t.id, type: 'OVERDUE', occurredAt: now, source: 'SERVER', details: { stage: 'admin', eta: eta.toISOString() } } });
      await notify({
        to: { admins: true },
        type: 'OVERDUE_URGENT',
        title: `Overdue: ${who}`,
        body: `Due back at ${fmtTime(eta, s.timezone)}, still out${t.lastAddress ? ` (last seen near ${t.lastAddress})` : ''}.`,
        link: `/admin/trips/${t.id}`,
        urgent: true,
      });
    }
  }
}

/** Approved bookings not started within the no-show window are released. */
export async function runNoShowCheck(now = new Date()) {
  const s = await getSettings();
  const candidates = await prisma.booking.findMany({
    where: { status: 'APPROVED', startAt: { lt: new Date(now.getTime() - s.noShowWindowMin * MINUTE) }, trip: null },
    include: { owner: { select: { id: true, name: true } }, car: { select: { registration: true } } },
  });
  for (const b of candidates) {
    if (!isNoShow(b, now, s)) continue;
    const joins = await prisma.$transaction(async (tx) => {
      const moved = await tx.booking.updateMany({ where: { id: b.id, status: 'APPROVED' }, data: { status: 'NO_SHOW' } });
      if (moved.count === 0) return null;
      await audit({ actorId: null, action: 'BOOKING_NO_SHOW', entity: 'Booking', entityId: b.id, before: { status: 'APPROVED' }, after: { status: 'NO_SHOW' } }, tx);
      return cancelPendingJoins(tx, b.id);
    });
    if (joins === null) continue;
    await notify({
      to: { userIds: [b.ownerId], admins: true },
      type: 'NO_SHOW',
      title: `No-show: ${b.car.registration} released`,
      body: `${shortName(b.owner.name)}'s trip at ${fmtTime(b.startAt, s.timezone)} wasn't started within ${s.noShowWindowMin} minutes, so the car and driver were released.`,
      link: `/bookings/${b.id}`,
      channels: ['IN_APP', 'PUSH'],
    });
    await notifyJoinsCancelled(joins, b, 'released as a no-show');
    await publishLive({ type: 'booking.changed', bookingId: b.id, status: 'NO_SHOW' });
  }
}

/** Remind the trip owner and admins until the end odometer reading is entered. */
export async function runAwaitingOdometerReminders(now = new Date()) {
  const s = await getSettings();
  const trips = await prisma.trip.findMany({
    where: {
      booking: { status: 'AWAITING_ODOMETER' },
      OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: new Date(now.getTime() - s.awaitingOdometerReminderMin * MINUTE) } }],
      // Stop nagging after three days; the admin closes it from the trip screen.
      awaitingOdometerAt: { gt: new Date(now.getTime() - 3 * 24 * 60 * MINUTE) },
    },
    include: { booking: { include: { owner: { select: { name: true } }, car: { select: { registration: true } } } } },
  });
  for (const t of trips) {
    await prisma.trip.update({ where: { id: t.id }, data: { lastReminderAt: now } });
    await notify({
      to: { userIds: [t.booking.ownerId], admins: true },
      type: 'AWAITING_ODOMETER_REMINDER',
      title: 'Reminder: end odometer reading needed',
      body: `${shortName(t.booking.owner.name)}'s trip in ${t.booking.car.registration} still needs its end odometer reading and photo.`,
      link: `/trips/${t.bookingId}?end=1`,
      channels: ['IN_APP', 'PUSH'],
    });
  }
}

/** Keep raw GPS for the retention period, then only trip summaries. */
export async function runGpsRetention(now = new Date()) {
  const s = await getSettings();
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - s.gpsRetentionMonths);
  const deleted = await prisma.$executeRaw`
    DELETE FROM "LocationPoint" lp USING "Trip" t
    WHERE lp."tripId" = t.id AND t."endedAt" IS NOT NULL AND t."endedAt" < ${cutoff}`;
  if (deleted > 0) console.log(`[retention] deleted ${deleted} GPS points from trips ended before ${cutoff.toISOString()}`);
  return deleted;
}

/** Retry delivery for anything left PENDING (e.g. queued while the worker was down). */
export async function runDispatchSweep(now = new Date()) {
  const stale = await prisma.notification.findMany({
    where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - MINUTE), gt: new Date(now.getTime() - 24 * 60 * MINUTE) } },
    select: { id: true },
    take: 500,
  });
  if (stale.length) await dispatchNotifications(stale.map((n) => n.id));
}
