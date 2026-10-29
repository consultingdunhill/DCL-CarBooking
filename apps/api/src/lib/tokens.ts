import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@carbooking/server';
import { jwtVerify, SignJWT } from 'jose';

const key = new TextEncoder().encode(env.APP_SECRET);
const ISSUER = 'carbooking';

export type TokenType = 'dev' | 'tracking';

/** Our own short-lived HS256 tokens: dev logins and trip-scoped tracking tokens. */
export async function signToken(typ: TokenType, sub: string, expiresAt: Date, claims: Record<string, unknown> = {}) {
  return new SignJWT({ ...claims, typ })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key);
}

export async function verifyToken(token: string, typ: TokenType) {
  const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
  if (payload.typ !== typ || !payload.sub) throw new Error('Wrong token type');
  return payload as typeof payload & { sub: string };
}

/** HMAC signature for time-limited file URLs (local storage driver). */
export function signPath(path: string, expiresAtSec: number): string {
  return createHmac('sha256', key).update(`${path}\n${expiresAtSec}`).digest('base64url');
}

export function verifyPathSignature(path: string, expiresAtSec: number, sig: string): boolean {
  if (!Number.isFinite(expiresAtSec) || expiresAtSec * 1000 < Date.now()) return false;
  const expected = Buffer.from(signPath(path, expiresAtSec));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
