import type { NotificationChannel } from '@carbooking/core';
import { prisma } from '@carbooking/db';
import { publishLive } from './live';
import { getBoss, QUEUES } from './queue';

export interface NotifyInput {
  /** Users to notify. `admins: true` adds every active admin (all admins get every request). */
  to: { userIds?: (string | null | undefined)[]; admins?: boolean };
  exclude?: (string | null | undefined)[];
  type: string;
  title: string;
  body: string;
  /** Path inside the app, e.g. /bookings/<id>. */
  link?: string;
  /** Defaults to in-app + push + email. */
  channels?: NotificationChannel[];
  /** Urgent alerts (overdue, tracking lost) also go by SMS/WhatsApp. */
  urgent?: boolean;
  payload?: Record<string, unknown>;
}

const DEFAULT_CHANNELS: NotificationChannel[] = ['IN_APP', 'PUSH', 'EMAIL'];

/**
 * Record notifications and queue delivery. In-app notifications are visible
 * immediately; push, email and SMS are sent by the worker.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const ids = new Set(input.to.userIds?.filter((x): x is string => Boolean(x)) ?? []);
  if (input.to.admins) {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } });
    admins.forEach((a) => ids.add(a.id));
  }
  for (const x of input.exclude ?? []) if (x) ids.delete(x);
  if (ids.size === 0) return;

  const channels = new Set(input.channels ?? DEFAULT_CHANNELS);
  if (input.urgent) {
    channels.add('SMS');
    channels.add('WHATSAPP');
  }
  const now = new Date();
  const rows = [...ids].flatMap((userId) =>
    [...channels].map((channel) => ({
      userId,
      channel,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
      payload: (input.payload ?? undefined) as object | undefined,
      status: channel === 'IN_APP' ? ('SENT' as const) : ('PENDING' as const),
      sentAt: channel === 'IN_APP' ? now : null,
    })),
  );
  const created = await prisma.notification.createManyAndReturn({ data: rows, select: { id: true, channel: true } });
  const pending = created.filter((n) => n.channel !== 'IN_APP').map((n) => n.id);

  await Promise.all([...ids].map((userId) => publishLive({ type: 'notification', userId })));
  if (pending.length) {
    try {
      const boss = await getBoss({ worker: false });
      await boss.send(QUEUES.dispatch, { ids: pending }, { retryLimit: 3, retryDelay: 30, retryBackoff: true });
    } catch (err) {
      // The worker's sweep picks up anything still PENDING.
      console.error('[notify] could not queue dispatch', (err as Error).message);
    }
  }
}
