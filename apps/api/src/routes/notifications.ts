import { DomainError, PushSubscriptionSchema } from '@carbooking/core';
import { prisma } from '@carbooking/db';
import { env, notify, pushConfigured, readWhatsappStatus } from '@carbooking/server';
import type { FastifyInstance } from 'fastify';
import { me } from '../lib/auth';
import { parse } from '../lib/http';

export async function notificationRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string } }>('/notifications', async (req) => {
    const user = me(req);
    const take = Math.min(100, Number(req.query.limit) || 30);
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: user.id, channel: 'IN_APP' },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, type: true, title: true, body: true, link: true, readAt: true, createdAt: true },
      }),
      prisma.notification.count({ where: { userId: user.id, channel: 'IN_APP', readAt: null } }),
    ]);
    return { items, unread };
  });

  app.post<{ Body: { ids?: string[]; all?: boolean } }>('/notifications/read', async (req) => {
    const user = me(req);
    await prisma.notification.updateMany({
      where: { userId: user.id, channel: 'IN_APP', readAt: null, ...(req.body?.all ? {} : { id: { in: req.body?.ids ?? [] } }) },
      data: { readAt: new Date() },
    });
    return { ok: true };
  });

  /** Linked-device WhatsApp: status and QR code (saved by the worker, which holds the session). */
  app.get('/admin/whatsapp', { config: { auth: 'admin' } }, async () => readWhatsappStatus());

  /** Send the signed-in admin a WhatsApp test message (delivered by the worker). */
  app.post('/admin/whatsapp/test', { config: { auth: 'admin' } }, async (req) => {
    const user = me(req);
    if (!user.phone) throw new DomainError('NO_PHONE', 'Add your mobile number in your profile first');
    await notify({
      to: { userIds: [user.id] },
      type: 'WHATSAPP_TEST',
      title: 'Fleet test message',
      body: 'WhatsApp alerts are working. Urgent trip requests, overdue trips and lost tracking will arrive here.',
      channels: ['WHATSAPP'],
    });
    return { ok: true, to: user.phone };
  });

  app.get('/push/config', async () => ({ vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null, ...pushConfigured() }));

  /** Register this browser (Web Push) or phone (FCM token) for push notifications. */
  app.post('/push/subscriptions', async (req) => {
    const user = me(req);
    const body = parse(PushSubscriptionSchema, req.body);
    const endpoint = body.kind === 'WEB' ? body.endpoint : body.token;
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: {
        userId: user.id,
        kind: body.kind,
        endpoint,
        keys: body.kind === 'WEB' ? body.keys : undefined,
        platform: body.kind === 'FCM' ? body.platform : 'web',
        userAgent: req.headers['user-agent']?.slice(0, 300),
      },
      update: { userId: user.id, keys: body.kind === 'WEB' ? body.keys : undefined, lastUsedAt: new Date() },
    });
    return { ok: true };
  });

  app.delete<{ Body: { endpoint: string } }>('/push/subscriptions', async (req) => {
    const user = me(req);
    await prisma.pushSubscription.deleteMany({ where: { userId: user.id, endpoint: req.body?.endpoint ?? '' } });
    return { ok: true };
  });
}
