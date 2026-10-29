import { conflict, MeUpdateSchema, notFound } from '@carbooking/core';
import { prisma } from '@carbooking/db';
import { audit, env, getSettings } from '@carbooking/server';
import type { FastifyInstance } from 'fastify';
import { me } from '../lib/auth';
import { ipOf, parse } from '../lib/http';
import { signToken } from '../lib/tokens';

const meSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  department: true,
  jobRole: { select: { id: true, name: true } },
  privacyAckAt: true,
  privacyAckVersion: true,
} as const;

export async function authRoutes(app: FastifyInstance) {
  /** What the web app needs to sign in. */
  app.get('/auth/config', { config: { auth: 'public' } }, async () => ({
    mode: env.AUTH_MODE,
    tenantId: env.ENTRA_TENANT_ID ?? null,
  }));

  if (env.AUTH_MODE === 'dev') {
    // Development only: pick a seeded user instead of signing in with Microsoft 365.
    app.get('/auth/dev-users', { config: { auth: 'public' } }, async () =>
      prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true, role: true, department: true }, orderBy: [{ role: 'asc' }, { name: 'asc' }] }),
    );
    app.post<{ Body: { userId: string } }>('/auth/dev-login', { config: { auth: 'public' } }, async (req) => {
      const user = await prisma.user.findUnique({ where: { id: req.body?.userId ?? '' } });
      if (!user || !user.active) throw notFound('User');
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      return { token: await signToken('dev', user.id, new Date(Date.now() + 30 * 24 * 3600_000)) };
    });
  }

  app.get('/me', async (req) => {
    const user = me(req);
    const s = await getSettings();
    const profile = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: meSelect });
    return { ...profile, privacyNoticeVersion: s.privacyNoticeVersion, privacyAckRequired: profile.privacyAckVersion !== s.privacyNoticeVersion };
  });

  app.patch('/me', async (req) => {
    const user = me(req);
    const body = parse(MeUpdateSchema, req.body);
    return prisma.user.update({ where: { id: user.id }, data: body, select: meSelect });
  });

  /** Acknowledge the location-tracking privacy notice (Kenya Data Protection Act). */
  app.post<{ Body: { version: string } }>('/me/privacy-ack', async (req) => {
    const user = me(req);
    const s = await getSettings();
    if (req.body?.version !== s.privacyNoticeVersion) throw conflict('STALE_NOTICE', 'The privacy notice has changed. Reload and read it again.');
    await prisma.user.update({ where: { id: user.id }, data: { privacyAckAt: new Date(), privacyAckVersion: s.privacyNoticeVersion } });
    await audit({ actorId: user.id, action: 'PRIVACY_ACKNOWLEDGED', entity: 'User', entityId: user.id, after: { version: s.privacyNoticeVersion }, ip: ipOf(req) });
    return { ok: true };
  });
}
