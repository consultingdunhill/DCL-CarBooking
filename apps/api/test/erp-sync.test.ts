/**
 * The read-only ERPNext copy: what is sent, when, and what ERPNext would refuse.
 *
 * A fake ERPNext stands in for the real site. It applies the checks ERPNext itself makes
 * against the doctypes in packages/server/src/erp/schema.ts: unknown fields, Select values
 * outside the options, Data longer than its column, missing required fields, links to
 * documents that don't exist, and deleting a document something still links to.
 */
import { randomUUID } from 'node:crypto';
import { costedTripsAndCarMonths } from '@carbooking/core';
import {
  bookingRef,
  carRef,
  env,
  ErpClient,
  erpSchema,
  erpSyncWarning,
  HEALTH_KEY,
  loadDataset,
  reconcileErp,
  runErpSync,
  syncToErp,
} from '@carbooking/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, loginAs, north, prisma, seedBasics } from './helpers';

const BREAKS = new Set(['Section Break', 'Column Break', 'Tab Break']);
type Doc = Record<string, unknown>;

class FakeErp {
  docs = new Map<string, Map<string, Doc>>();
  writes: string[] = [];
  failNames = new Set<string>();
  down = false;
  logins = 0;
  expireSession = false;
  meta = new Map(erpSchema.allDoctypes().map((d) => [d.name, d]));

  constructor(crm: { listings?: string[]; leads?: string[] } = {}) {
    this.docs.set('DC Listing', new Map((crm.listings ?? []).map((n) => [n, {}])));
    this.docs.set('DC Lead', new Map((crm.leads ?? []).map((n) => [n, {}])));
  }

  store(doctype: string) {
    if (!this.docs.has(doctype)) this.docs.set(doctype, new Map());
    return this.docs.get(doctype)!;
  }

  check(doctype: string, doc: Doc) {
    const fields = new Map(this.meta.get(doctype)!.fields.filter((f) => !BREAKS.has(f.fieldtype)).map((f) => [f.fieldname, f]));
    for (const [key, v] of Object.entries(doc)) {
      const f = fields.get(key);
      if (!f) throw new Error(`${doctype}: unknown field ${key}`);
      if (v == null || v === '') continue;
      if (f.fieldtype === 'Select' && !f.options!.split('\n').includes(v as string)) throw new Error(`${doctype}.${key}: ${v} not an option`);
      if (f.fieldtype === 'Data' && (v as string).length > (f.length ?? 140)) throw new Error(`${doctype}.${key}: too long`);
      if (f.fieldtype === 'Link' && !this.store(f.options!).has(v as string)) throw new Error(`${doctype}.${key}: no ${f.options} ${v}`);
      if (f.fieldtype === 'Table') for (const row of v as Doc[]) this.check(f.options!, row);
      if (f.fieldtype === 'Datetime' && !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v as string)) throw new Error(`${doctype}.${key}: ${v}`);
      if (f.fieldtype === 'Date' && !/^\d{4}-\d\d-\d\d$/.test(v as string)) throw new Error(`${doctype}.${key}: ${v}`);
      if (f.fieldtype === 'Int' && !Number.isInteger(v)) throw new Error(`${doctype}.${key}: ${v} is not whole`);
    }
    for (const [key, f] of fields) if (f.reqd && (doc[key] == null || doc[key] === '')) throw new Error(`${doctype}: ${key} is required`);
  }

  linkedFrom(doctype: string, name: string): string[] {
    const hits: string[] = [];
    for (const [other, docs] of this.docs) {
      const links = this.meta.get(other)?.fields.filter((f) => f.fieldtype === 'Link' && f.options === doctype).map((f) => f.fieldname) ?? [];
      for (const [n, d] of docs) if (links.some((l) => d[l] === name)) hits.push(`${other} ${n}`);
    }
    return hits;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (this.down) return new Response('Bad Gateway', { status: 502 });
    const url = new URL(String(input));
    if (url.pathname === '/api/method/login') {
      this.logins++;
      return json(200, { message: 'Logged In' }, { 'set-cookie': `sid=s${this.logins}; Path=/; HttpOnly` });
    }
    if (this.expireSession) {
      this.expireSession = false;
      return json(403, { exc_type: 'PermissionError' });
    }
    const [doctype, name] = url.pathname.split('/').slice(3).map(decodeURIComponent) as [string, string | undefined];
    const store = this.store(doctype);
    const method = init.method ?? 'GET';
    if (method === 'GET' && !name) return json(200, { data: [...store.keys()].map((n) => ({ name: n })) });
    if (method === 'GET') return store.has(name!) ? json(200, { data: store.get(name!) }) : json(404, {});
    if (method === 'DELETE') {
      if (!store.has(name!)) return json(404, {});
      const linked = this.linkedFrom(doctype, name!);
      if (linked.length) return json(417, { exc_type: 'LinkExistsError', message: `linked with ${linked}` });
      store.delete(name!);
      this.writes.push(`DELETE ${doctype} ${name}`);
      return json(202, { message: 'ok' });
    }
    const doc = JSON.parse(String(init.body)) as Doc;
    const target = method === 'POST' ? (doc.fleet_ref as string) : name!;
    if (this.failNames.has(target)) return json(417, { exc_type: 'ValidationError', message: 'refused for the test' });
    try {
      this.check(doctype, doc);
    } catch (err) {
      return json(417, { exc_type: 'ValidationError', message: (err as Error).message });
    }
    if (method === 'POST') {
      if (store.has(target)) return json(409, { exc_type: 'DuplicateEntryError' });
      store.set(target, doc);
    } else {
      if (!store.has(target) && !this.meta.get(doctype)?.issingle) return json(404, {});
      store.set(target, { ...(store.get(target) ?? {}), ...doc });
    }
    this.writes.push(`${method} ${doctype} ${target}`);
    return json(200, { data: store.get(target) });
  };
}

const client = (fake: FakeErp, auth: 'key' | 'password' = 'key') =>
  new ErpClient({
    url: 'https://erp.test',
    ...(auth === 'key' ? { apiKey: 'k'.repeat(15), apiSecret: 's'.repeat(15) } : { user: 'sync@test.ke', password: 'p'.repeat(32) }),
    fetchImpl: fake.fetch,
  });

/** One finished trip with a viewing at one of the CRM's listings, for a CRM lead; one fuel fill-up. */
async function seedTrip() {
  const base = await seedBasics();
  const role = await prisma.jobRole.create({ data: { name: 'Sales agent' } });
  await prisma.user.update({ where: { id: base.jane.id }, data: { jobRoleId: role.id } });
  await prisma.hourlyRate.createMany({
    data: [
      { jobRoleId: role.id, rate: 500, effectiveFrom: new Date('2026-01-01') },
      { forDriver: true, rate: 300, effectiveFrom: new Date('2026-01-01') },
    ],
  });
  const listing = await prisma.property.create({ data: { ref: 'DQ-42', crmRef: 'dq:42', address: 'Flat 4, Westlands', ...north(2000), service: 'SALES' } });
  await prisma.fuelEntry.create({ data: { carId: base.car1.id, date: new Date('2026-11-02T06:00:00Z'), litres: 40, amount: 8000, enteredById: base.admin.id } });
  const start = new Date('2026-11-10T06:00:00Z');
  const booking = await prisma.booking.create({
    data: {
      ownerId: base.jane.id,
      driverId: base.driver.id,
      carId: base.car1.id,
      status: 'COMPLETED',
      startAt: start,
      expectedReturnAt: new Date(start.getTime() + 3 * 3600_000),
      reasonId: base.viewing.id,
      decidedById: base.admin.id,
      decidedAt: new Date(start.getTime() - 3600_000),
      stops: {
        create: [
          {
            seq: 1, propertyId: listing.id, address: listing.address, ...north(2000), addedById: base.jane.id, reasonId: base.viewing.id,
            status: 'DEPARTED', arrivedAt: new Date(start.getTime() + 1800_000), departedAt: new Date(start.getTime() + 3600_000),
            crmLeadRef: '7', crmLeadName: 'Ada Okoth',
          },
          { seq: 2, address: 'Bank, Westlands', ...north(500), addedById: base.jane.id, reasonId: base.errand.id, status: 'SKIPPED' },
        ],
      },
    },
  });
  await prisma.trip.create({
    data: {
      bookingId: booking.id, startedAt: start, endedAt: new Date(start.getTime() + 2 * 3600_000), odometerStart: 10_000, odometerEnd: 10_030,
      photoStartKey: 'x', startRequestId: randomUUID(), endMethod: 'MANUAL', trackingStatus: 'STOPPED', gpsDistanceKm: 28.4,
    },
  });
  const pending = await prisma.booking.create({
    data: { ownerId: base.tom.id, driverId: base.driver.id, carId: base.car2.id, status: 'PENDING', startAt: new Date('2026-11-20T07:00:00Z'), expectedReturnAt: new Date('2026-11-20T09:00:00Z') },
  });
  return { ...base, listing, booking, pending };
}

describe('the ERPNext copy', () => {
  let fake: FakeErp;
  beforeEach(() => {
    fake = new FakeErp({ listings: ['PROP-0042'], leads: ['LEAD-0007'] });
  });

  it('sends every record on the first run, and ERPNext accepts them', async () => {
    const s = await seedTrip();
    const r = await syncToErp(client(fake));

    expect(r.errors).toEqual([]);
    expect(r.created).toBe(2 + 2 + 1 + 1); // cars, bookings, fuel entry, one car-month with km and fuel
    const b = fake.docs.get('Fleet Booking')!.get(bookingRef(s.booking.id))!;
    expect(b).toMatchObject({ status: 'Completed', booked_by: 'Jane Mwangi', car: carRef(s.car1.id), car_registration: 'KDA 001A', trip_km: 30, gps_km: 28.4 });
    expect(b.starts_at).toBe('2026-11-10 09:00:00'); // Nairobi time
    const stops = b.stops as Doc[];
    expect(stops[0]).toMatchObject({ listing: 'PROP-0042', lead: 'LEAD-0007', lead_name: 'Ada Okoth', counts_as_viewing: 1, status: 'Departed' });
    expect(stops[1]).toMatchObject({ listing: null, lead: null, status: 'Skipped', stop_cost: null });

    // The same costs as Fleet's own reports.
    const ds = await loadDataset(new Date('2026-11-01'), new Date('2026-12-01'));
    const { trips } = costedTripsAndCarMonths(ds, { from: new Date('2026-11-01'), to: new Date('2026-12-01') });
    const cost = trips.find((t) => t.booking.id === s.booking.id)!.cost;
    expect(b.total_cost).toBeCloseTo(cost.totalCost, 2);
    expect(b.fuel_cost).toBeCloseTo(cost.fuelCost, 2);
    expect(stops[0]!.stop_cost).toBeCloseTo(cost.stops[0]!.totalCost, 2);
    expect(fake.docs.get('Fleet Booking')!.get(bookingRef(s.pending.id))!.total_cost).toBeNull();
  });

  it('links a stop to a CRM listing or lead only when ERPNext has it', async () => {
    const s = await seedTrip();
    fake = new FakeErp(); // the CRM's copy isn't there
    const r = await syncToErp(client(fake));
    expect(r.errors).toEqual([]);
    const stop = (fake.docs.get('Fleet Booking')!.get(bookingRef(s.booking.id))!.stops as Doc[])[0]!;
    expect(stop).toMatchObject({ listing: null, lead: null, lead_name: 'Ada Okoth' });
  });

  it('sends nothing on a second run, and only what changed after that', async () => {
    const s = await seedTrip();
    await syncToErp(client(fake));
    fake.writes = [];

    expect((await syncToErp(client(fake))).unchanged).toBe(6);
    expect(fake.writes).toEqual([]);

    await prisma.booking.update({ where: { id: s.pending.id }, data: { status: 'APPROVED' } });
    await syncToErp(client(fake));
    expect(fake.writes).toEqual([`PUT Fleet Booking ${bookingRef(s.pending.id)}`]);
  });

  it('deletes from ERPNext what Fleet no longer has', async () => {
    const s = await seedTrip();
    await syncToErp(client(fake));
    await prisma.booking.delete({ where: { id: s.pending.id } });

    const r = await syncToErp(client(fake));
    expect(r.deleted).toBe(1);
    expect(fake.docs.get('Fleet Booking')!.has(bookingRef(s.pending.id))).toBe(false);
  });

  it("doesn't let one refused record stop the rest, and retries it later", async () => {
    const s = await seedTrip();
    const refused = bookingRef(s.pending.id);
    fake.failNames.add(refused);

    const r = await syncToErp(client(fake));
    expect(r.failed).toBe(1);
    expect(fake.docs.get('Fleet Booking')!.has(bookingRef(s.booking.id))).toBe(true);
    expect((await prisma.erpSyncState.findFirst({ where: { erpName: refused } }))!.lastError).toContain('refused for the test');

    fake.writes = [];
    await syncToErp(client(fake)); // unchanged and failed recently: left alone
    expect(fake.writes).toEqual([]);

    fake.failNames.clear();
    await syncToErp(client(fake), { now: new Date(Date.now() + 31 * 60_000) });
    expect(fake.docs.get('Fleet Booking')!.has(refused)).toBe(true);
  });

  it('sends and records nothing on a dry run', async () => {
    await seedTrip();
    const r = await syncToErp(client(fake), { dryRun: true });
    expect(r.created).toBe(6);
    expect(fake.writes).toEqual([]);
    expect(await prisma.erpSyncState.count()).toBe(0);
  });

  it('puts back what was deleted by hand and removes strays, but not other names', async () => {
    const s = await seedTrip();
    await syncToErp(client(fake));
    fake.docs.get('Fleet Booking')!.delete(bookingRef(s.pending.id));
    fake.docs.get('Fleet Booking')!.set('BK-deadbeef', { fleet_ref: 'BK-deadbeef' });
    fake.docs.get('Fleet Booking')!.set('SOMEONE-ELSES', { fleet_ref: 'SOMEONE-ELSES' });

    const r = await reconcileErp(client(fake));
    expect(r.errors).toEqual([]);
    const bookings = fake.docs.get('Fleet Booking')!;
    expect(bookings.has(bookingRef(s.pending.id))).toBe(true);
    expect(bookings.has('BK-deadbeef')).toBe(false);
    expect(bookings.has('SOMEONE-ELSES')).toBe(true);
  });
});

describe('the status card and the admin warning', () => {
  const was = env.ERP_SYNC_ENABLED;
  beforeEach(() => {
    (env as { ERP_SYNC_ENABLED: boolean }).ERP_SYNC_ENABLED = true;
  });
  afterEach(() => {
    (env as { ERP_SYNC_ENABLED: boolean }).ERP_SYNC_ENABLED = was;
  });

  it('writes the status every run and clears the warning', async () => {
    await seedTrip();
    const fake = new FakeErp({ listings: ['PROP-0042'], leads: ['LEAD-0007'] });
    await runErpSync(client(fake));
    fake.writes = [];
    await runErpSync(client(fake));
    expect(fake.writes).toEqual(['PUT Fleet Sync Status Fleet Sync Status']);
    expect(fake.docs.get('Fleet Sync Status')!.get('Fleet Sync Status')).toMatchObject({ failing_records: 0, sent: 0, interval_minutes: 2 });
    expect(await erpSyncWarning()).toBeNull();
  });

  it('warns about stuck records, an unreachable ERPNext, a stopped sync, and one never run', async () => {
    const s = await seedTrip();
    expect(await erpSyncWarning()).toContain('hasn’t run yet');

    const fake = new FakeErp({ listings: ['PROP-0042'], leads: ['LEAD-0007'] });
    fake.failNames.add(bookingRef(s.pending.id));
    await runErpSync(client(fake));
    expect(await erpSyncWarning()).toMatch(/^1 record couldn’t be copied to ERPNext/);

    fake.down = true;
    await expect(runErpSync(client(fake))).rejects.toThrow('502');
    expect(await erpSyncWarning()).toMatch(/^The copy to ERPNext is failing \(couldn’t reach ERPNext/);

    expect(await erpSyncWarning(new Date(Date.now() + 16 * 60_000))).toContain('hasn’t run since');
    expect((await prisma.setting.findUnique({ where: { key: HEALTH_KEY } }))!.value).toMatchObject({ failingRecords: 1 });
  });

  it("shows admins the warning through the API, and refuses staff", async () => {
    const s = await seedTrip();
    const fake = new FakeErp({ listings: ['PROP-0042'], leads: ['LEAD-0007'] });
    fake.failNames.add(bookingRef(s.pending.id));
    await runErpSync(client(fake));
    const app = await buildApp({ logger: false });
    try {
      const admin = await loginAs(app, s.admin.id);
      const staff = await loginAs(app, s.jane.id);
      const res = await admin.get<{ warning: string | null }>('/admin/erp-sync');
      expect(res.status).toBe(200);
      expect(res.body.warning).toMatch(/^1 record couldn’t be copied to ERPNext/);
      expect((await staff.get('/admin/erp-sync')).status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('keeps one password session across runs and renews it when ERPNext drops it', async () => {
    await seedTrip();
    const fake = new FakeErp();
    const c = client(fake, 'password');
    await runErpSync(c);
    await runErpSync(c);
    expect(fake.logins).toBe(1);
    fake.expireSession = true;
    await runErpSync(c);
    expect(fake.logins).toBe(2);
  });
});

describe('the doctypes', () => {
  it('stay inside our module and rules', () => {
    const defs = erpSchema.allDoctypes();
    const names = defs.map((d) => d.name);
    defs.forEach((d, i) => {
      expect(d.name.startsWith('Fleet ')).toBe(true);
      expect(d.module).toBe('Dunhill Fleet');
      for (const f of d.fields) {
        expect(f.fieldtype === 'Link' && f.options === 'Company').toBe(false);
        if (!BREAKS.has(f.fieldtype)) expect(f.read_only, `${d.name}.${f.fieldname}`).toBe(1);
        if (['Link', 'Table'].includes(f.fieldtype) && f.options!.startsWith('Fleet ')) expect(names.indexOf(f.options!)).toBeLessThan(i);
      }
      for (const p of d.permissions ?? []) {
        // ERPNext switches an omitted flag on, so every flag must be spelled out
        expect(erpSchema.PERMISSION_FLAGS.filter((flag) => !(flag in p))).toEqual([]);
        if (p.role !== 'Dunhill Integration') expect([p.write, p.create, p.delete]).toEqual([0, 0, 0]);
      }
    });
    const booking = defs.find((d) => d.name === 'Fleet Booking')!;
    const costFields = booking.fields.filter((f) => f.fieldtype === 'Currency');
    expect(costFields.every((f) => f.permlevel === 1)).toBe(true);
    const level1 = (booking.permissions ?? []).filter((p) => p.permlevel === 1).map((p) => p.role);
    expect(level1).toEqual(['Fleet Manager', 'System Manager', 'Dunhill Integration']);
  });
});
