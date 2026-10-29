import { prisma } from '@carbooking/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

export const MIN = 60_000;

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'spatial_ref_sys')`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export const OFFICE = { lat: -1.26745, lng: 36.80755 };
/** A point `m` metres north of the office. */
export const north = (m: number) => ({ lat: OFFICE.lat + m / 111_195, lng: OFFICE.lng });

export async function seedBasics() {
  await resetDb();
  const office = await prisma.office.create({ data: { name: 'HQ', address: 'Westlands', ...OFFICE } });
  const driver = await prisma.driver.create({ data: { name: 'Peter Kamau', phone: '+254711000001' } });
  const car1 = await prisma.car.create({ data: { registration: 'KDA 001A', make: 'Toyota', model: 'Axio', fuelType: 'PETROL', homeOfficeId: office.id, currentOdometer: 10_000 } });
  const car2 = await prisma.car.create({ data: { registration: 'KDB 002B', make: 'Toyota', model: 'Fielder', fuelType: 'PETROL', homeOfficeId: office.id, currentOdometer: 20_000 } });
  const viewing = await prisma.visitReason.create({ data: { label: 'Sales viewing', department: 'SALES', countsAsViewing: true, needsProperty: true } });
  const errand = await prisma.visitReason.create({ data: { label: 'Bank', department: 'OTHER' } });
  const ack = { privacyAckAt: new Date(), privacyAckVersion: '2026-10' };
  const admin = await prisma.user.create({ data: { name: 'Grace Admin', email: 'grace@test.ke', role: 'ADMIN', phone: '+254700000001', ...ack } });
  const admin2 = await prisma.user.create({ data: { name: 'Otis Admin', email: 'otis@test.ke', role: 'ADMIN', ...ack } });
  const jane = await prisma.user.create({ data: { name: 'Jane Mwangi', email: 'jane@test.ke', phone: '0722000011', department: 'SALES', ...ack } });
  const tom = await prisma.user.create({ data: { name: 'Tom Otieno', email: 'tom@test.ke', phone: '0722000012', department: 'LETTINGS', ...ack } });
  const property = await prisma.property.create({ data: { ref: 'S-1', crmRef: 'CRM-1', address: 'Villa, Lavington', ...north(3000), service: 'SALES' } });
  return { office, driver, car1, car2, viewing, errand, admin, admin2, jane, tom, property };
}

export class Client {
  constructor(
    private app: FastifyInstance,
    readonly token?: string,
  ) {}

  async req<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method,
      url,
      payload: body as never,
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...headers },
    });
    let json: T | undefined;
    try {
      json = res.json() as T;
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, body: json as T, raw: res };
  }
  get = <T = any>(url: string) => this.req<T>('GET', url);
  post = <T = any>(url: string, body?: unknown) => this.req<T>('POST', url, body ?? {});
}

export async function loginAs(app: FastifyInstance, userId: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { userId } });
  return new Client(app, res.json().token);
}

/** Upload a fake odometer photo through the signed-URL flow. */
export async function uploadPhoto(app: FastifyInstance, client: Client, kind: 'ODOMETER_START' | 'ODOMETER_END') {
  const { body } = await client.post<{ key: string; url: string }>('/uploads', { kind, contentType: 'image/jpeg' });
  const path = new URL(body.url).pathname + new URL(body.url).search;
  const put = await app.inject({ method: 'PUT', url: path, payload: Buffer.from('fake-jpeg'), headers: { 'content-type': 'image/jpeg' } });
  if (put.statusCode !== 201) throw new Error(`upload failed ${put.statusCode} ${put.body}`);
  return body.key;
}

export function fix(at: Date, pos: { lat: number; lng: number }, extra: Record<string, unknown> = {}) {
  return {
    uuid: `${at.getTime()}-${pos.lat.toFixed(6)}`,
    timestamp: at.toISOString(),
    is_moving: true,
    coords: { latitude: pos.lat, longitude: pos.lng, accuracy: 8, speed: 8 },
    battery: { level: 0.8, is_charging: false },
    ...extra,
  };
}

export { buildApp, prisma };
