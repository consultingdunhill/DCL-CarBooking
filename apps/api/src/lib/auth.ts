import { DomainError, forbidden } from '@carbooking/core';
import { prisma, type User } from '@carbooking/db';
import { env } from '@carbooking/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { verifyToken } from './tokens';

export type AuthUser = User;
export type AuthLevel = 'public' | 'user' | 'admin' | 'tracking';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    tracking: { tripId: string; userId: string } | null;
  }
  interface FastifyContextConfig {
    auth?: AuthLevel;
  }
}

const unauthorized = (message = 'Sign in again') => new DomainError('UNAUTHORIZED', message, 401);

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

// ── Microsoft Entra ID ────────────────────────────────────────────────────────

const jwks = env.ENTRA_TENANT_ID
  ? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/discovery/v2.0/keys`))
  : null;
const entraIssuers = env.ENTRA_TENANT_ID
  ? [`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`, `https://sts.windows.net/${env.ENTRA_TENANT_ID}/`]
  : [];
const audiences = (env.ENTRA_API_AUDIENCE ?? '').split(',').map((s) => s.trim()).filter(Boolean);

interface EntraClaims extends JWTPayload {
  oid?: string;
  name?: string;
  preferred_username?: string;
  upn?: string;
  email?: string;
  roles?: string[];
}

const userCache = new Map<string, { at: number; user: User }>();
const CACHE_MS = 60_000;

/**
 * Validate an Entra access token and sync the user. Access is controlled by
 * Entra app roles (Staff, Admin), so removing someone in Microsoft 365 removes
 * their access here.
 */
async function entraUser(token: string): Promise<User> {
  if (!jwks) throw unauthorized('Entra ID is not configured');
  let claims: EntraClaims;
  try {
    ({ payload: claims } = await jwtVerify<EntraClaims>(token, jwks, { issuer: entraIssuers, audience: audiences }));
  } catch {
    throw unauthorized();
  }
  if (!claims.oid) throw unauthorized();
  const cached = userCache.get(claims.oid);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.user;

  const roles = claims.roles ?? [];
  if (!roles.includes(env.ENTRA_ADMIN_ROLE) && !roles.includes(env.ENTRA_STAFF_ROLE)) {
    throw forbidden('Your account has not been given access to the car booking app. Ask IT to assign you the Staff role.');
  }
  const role = roles.includes(env.ENTRA_ADMIN_ROLE) ? 'ADMIN' : 'STAFF';
  const email = (claims.preferred_username ?? claims.upn ?? claims.email ?? '').toLowerCase();
  const name = claims.name ?? email;
  const existing =
    (await prisma.user.findUnique({ where: { entraOid: claims.oid } })) ?? (email ? await prisma.user.findUnique({ where: { email } }) : null);
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { entraOid: claims.oid, name, email: email || existing.email, role, active: true, lastLoginAt: new Date() },
      })
    : await prisma.user.create({ data: { entraOid: claims.oid, name, email, role, lastLoginAt: new Date() } });
  userCache.set(claims.oid, { at: Date.now(), user });
  return user;
}

// ── Dev login (AUTH_MODE=dev only) ────────────────────────────────────────────

async function devUser(token: string): Promise<User> {
  let sub: string;
  try {
    ({ sub } = await verifyToken(token, 'dev'));
  } catch {
    throw unauthorized();
  }
  const user = await prisma.user.findUnique({ where: { id: sub } });
  if (!user) throw unauthorized();
  return user;
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('user', null);
  app.decorateRequest('tracking', null);

  app.addHook('onRequest', async (req) => {
    const level: AuthLevel = req.routeOptions.config?.auth ?? 'user';
    if (level === 'public' || req.method === 'OPTIONS') return;
    const token = bearer(req);
    if (!token) throw unauthorized('Not signed in');

    if (level === 'tracking') {
      try {
        const p = await verifyToken(token, 'tracking');
        req.tracking = { tripId: String(p.trip), userId: p.sub };
        return;
      } catch {
        throw new DomainError('TRACKING_TOKEN_INVALID', 'Tracking token expired or invalid', 401);
      }
    }

    const user = env.AUTH_MODE === 'dev' ? await devUser(token) : await entraUser(token);
    if (!user.active) throw forbidden('Your account is inactive');
    if (level === 'admin' && user.role !== 'ADMIN') throw forbidden('Admins only');
    req.user = user;
  });
});

export function me(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export const isAdmin = (req: FastifyRequest) => req.user?.role === 'ADMIN';
