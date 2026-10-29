import { fmtWindow, shortName } from '@carbooking/core';
import { prisma, type Prisma } from '@carbooking/db';
import { publishLive } from './live';
import { notify } from './notify';
import { getSettings } from './settings';

type Tx = Prisma.TransactionClient;

/**
 * When a booking is cancelled, rejected or released, its pending join
 * requests are cancelled and the joiners told.
 */
export async function cancelPendingJoins(tx: Tx, bookingId: string): Promise<{ id: string; requesterId: string }[]> {
  const joins = await tx.joinRequest.findMany({ where: { bookingId, status: 'PENDING' }, select: { id: true, requesterId: true } });
  if (joins.length === 0) return [];
  const ids = joins.map((j) => j.id);
  await tx.joinRequest.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELLED', decidedAt: new Date() } });
  await tx.bookingStop.updateMany({ where: { joinRequestId: { in: ids }, status: 'PROPOSED' }, data: { status: 'REJECTED' } });
  return joins;
}

export async function notifyJoinsCancelled(
  joins: { id: string; requesterId: string }[],
  booking: { id: string; startAt: Date; expectedReturnAt: Date; owner: { name: string } },
  why: string,
) {
  if (joins.length === 0) return;
  const { timezone } = await getSettings();
  await notify({
    to: { userIds: joins.map((j) => j.requesterId) },
    type: 'JOIN_CANCELLED',
    title: 'Your request to add a stop was cancelled',
    body: `${shortName(booking.owner.name)}'s trip (${fmtWindow(booking.startAt, booking.expectedReturnAt, timezone)}) was ${why}, so your stop request was cancelled.`,
    link: '/trips',
  });
  for (const j of joins) await publishLive({ type: 'join.changed', joinRequestId: j.id, bookingId: booking.id, status: 'CANCELLED' });
}
