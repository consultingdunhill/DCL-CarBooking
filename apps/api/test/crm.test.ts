/**
 * The Dunhill CRM link, against a fake CRM: "Book a car" on a lead fills in a booking,
 * and the nightly sync mirrors the CRM's portfolio without trampling our own edits.
 */
import { env, stopBoss } from '@carbooking/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, loginAs, prisma, seedBasics, type Client } from './helpers';

let app: FastifyInstance;
let s: Awaited<ReturnType<typeof seedBasics>>;
let admin: Client;
let jane: Client;
let tom: Client;

const listing = (id: number, over: Record<string, unknown> = {}) => ({
  ref: `dq:${id}`, id, title: `Listing ${id}`, listing_type: 'SALE', status: 'AVAILABLE', active: true,
  property_type: 'APARTMENT', location_text: 'Parklands', area_slug: 'parklands', external_url: null,
  lat: null as number | null, lng: null as number | null, location_note: null as string | null, updated_at: '2026-10-28T00:00:00Z', ...over,
});

/** What the fake CRM holds; each test edits it. */
let crm: { listings: ReturnType<typeof listing>[]; leads: Record<number, unknown>; down: boolean };
const seen: { url: string; auth: string | null }[] = [];

beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(async () => {
  await app.close();
  await stopBoss();
  await prisma.$disconnect();
});
beforeEach(async () => {
  s = await seedBasics();
  [admin, jane, tom] = await Promise.all([s.admin, s.jane, s.tom].map((u) => loginAs(app, u.id)));
  crm = {
    listings: [listing(7), listing(8, { listing_type: 'LET' })],
    leads: {
      42: {
        id: 42, first_name: 'Priya', service_type: 'BUY', service_label: 'Looking to buy',
        agent: { id: 3, full_name: 'Jane M', email: 'JANE@test.ke' },
        properties: [{ ref: 'dq:7', id: 7, title: 'Listing 7', location_text: 'Parklands', listing_type: 'SALE', lat: null, lng: null, location_note: null }],
      },
    },
    down: false,
  };
  seen.length = 0;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url: url.toString(), auth: new Headers(init?.headers).get('authorization') });
    if (crm.down) throw new TypeError('fetch failed');
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/integrations/fleet/properties') return json(200, { properties: crm.listings });
    const lead = url.pathname.match(/^\/api\/integrations\/fleet\/leads\/(\d+)$/);
    if (lead) return crm.leads[Number(lead[1])] ? json(200, crm.leads[Number(lead[1])]) : json(404, { detail: 'Not found' });
    return json(404, { detail: 'Not found' });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a lead from the CRM', () => {
  it('gives the booking form a first name and its listings as properties, creating any not yet synced', async () => {
    const r = await jane.get('/crm/leads/42');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ref: '42', firstName: 'Priya', serviceLabel: 'Looking to buy', agent: { name: 'Jane M', userId: s.jane.id } });
    expect(r.body.properties).toHaveLength(1);
    expect(r.body.properties[0]).toMatchObject({ ref: 'DQ-7', title: 'Listing 7', lat: null, service: 'SALES' });
    expect(await prisma.property.findUnique({ where: { crmRef: 'dq:7' } })).toMatchObject({ ref: 'DQ-7', address: 'Listing 7, Parklands', status: 'ACTIVE' });
    expect(seen[0]!.auth).toBe(`Bearer ${env.CRM_API_TOKEN}`);
  });

  it('is only shown to the agent the CRM assigned it to, or an admin', async () => {
    expect((await tom.get('/crm/leads/42')).status).toBe(403);
    expect((await admin.get('/crm/leads/42')).status).toBe(200);
  });

  it('reports an unknown lead and a CRM that is down distinctly', async () => {
    expect((await admin.get('/crm/leads/999')).status).toBe(404);
    expect((await admin.get('/crm/leads/abc')).status).toBe(404);
    crm.down = true;
    const r = await admin.get('/crm/leads/42');
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('CRM_UNAVAILABLE');
  });

  it('keeps the lead on the stops booked for it', async () => {
    const { body: lead } = await jane.get('/crm/leads/42');
    const p = lead.properties[0];
    const start = new Date(Math.ceil((Date.now() + 2 * 3600_000) / 900_000) * 900_000);
    const r = await jane.post('/bookings', {
      carId: s.car1.id,
      startAt: start.toISOString(),
      expectedReturnAt: new Date(start.getTime() + 2 * 3600_000).toISOString(),
      stops: [
        { address: p.address, lat: -1.26, lng: 36.81, propertyId: p.id, reasonId: s.viewing.id, crmLeadRef: lead.ref, crmLeadName: lead.firstName },
        // A name without a lead is dropped: the name only labels a lead.
        { address: 'Errand', lat: -1.27, lng: 36.8, reasonId: s.errand.id, crmLeadName: 'Stray' },
      ],
    });
    expect(r.status).toBe(201);
    const stops = await prisma.bookingStop.findMany({ where: { bookingId: r.body.id }, orderBy: { seq: 'asc' } });
    expect(stops.map((x) => [x.crmLeadRef, x.crmLeadName])).toEqual([['42', 'Priya'], [null, null]]);
  });

  it("takes a pin an agent has just set in the CRM, without waiting for tonight's sync", async () => {
    await jane.get('/crm/leads/42');
    expect((await prisma.property.findUniqueOrThrow({ where: { crmRef: 'dq:7' } })).lat).toBeNull();
    const lead = crm.leads[42] as { properties: Record<string, unknown>[] };
    Object.assign(lead.properties[0]!, { lat: -1.259094, lng: 36.782915, location_note: 'Second gate' });

    const r = await jane.get('/crm/leads/42');
    expect(r.body.properties[0]).toMatchObject({ lat: -1.259094, lng: 36.782915, directions: 'Second gate' });
    expect(await prisma.property.findUniqueOrThrow({ where: { crmRef: 'dq:7' } })).toMatchObject({ lat: -1.259094, lng: 36.782915 });
  });

  it('answers 404 when the link is not configured', async () => {
    const saved = env.CRM_API_URL;
    env.CRM_API_URL = undefined;
    try {
      expect((await admin.get('/crm/leads/42')).status).toBe(404);
      expect((await admin.post('/admin/crm/sync')).status).toBe(404);
    } finally {
      env.CRM_API_URL = saved;
    }
  });
});

describe('portfolio sync', () => {
  it('creates, then leaves alone, then follows status changes and withdrawals', async () => {
    expect((await jane.post('/admin/crm/sync')).status).toBe(403);

    let r = await admin.post('/admin/crm/sync');
    expect(r.body).toMatchObject({ listings: 2, created: 2, updated: 0, withdrawn: 0 });
    expect((await prisma.property.findUniqueOrThrow({ where: { crmRef: 'dq:8' } })).service).toBe('LETTINGS');

    // The address is ours to improve; the CRM must not undo that.
    await prisma.property.update({ where: { crmRef: 'dq:7' }, data: { address: 'Block B, 3rd Parklands Ave' } });
    r = await admin.post('/admin/crm/sync');
    expect(r.body).toMatchObject({ created: 0, updated: 0, unchanged: 2 });

    // An agent pins it in the CRM, and later the website marks it sold.
    crm.listings = [listing(7, { lat: -1.259094, lng: 36.782915 }), listing(8, { listing_type: 'LET' })];
    r = await admin.post('/admin/crm/sync');
    expect(r.body).toMatchObject({ updated: 1, unchanged: 1 });
    crm.listings = [listing(7, { status: 'SOLD', active: false, lat: -1.259094, lng: 36.782915 })];
    r = await admin.post('/admin/crm/sync');
    expect(r.body).toMatchObject({ updated: 1, withdrawn: 1 });
    expect(await prisma.property.findUniqueOrThrow({ where: { crmRef: 'dq:7' } })).toMatchObject({ status: 'SOLD', lat: -1.259094, lng: 36.782915, address: 'Block B, 3rd Parklands Ave' });
    expect((await prisma.property.findUniqueOrThrow({ where: { crmRef: 'dq:8' } })).status).toBe('WITHDRAWN');
    // Our own properties are not the CRM's to withdraw.
    expect((await prisma.property.findUniqueOrThrow({ where: { id: s.property.id } })).status).toBe('ACTIVE');

    const last = await admin.get('/admin/crm/last-sync');
    expect(last.body).toMatchObject({ enabled: true, summary: { updated: 1, withdrawn: 1 } });
  });

  it('follows the CRM when an agent moves or removes a pin', async () => {
    crm.listings = [listing(7, { lat: -1.25, lng: 36.8 })];
    await admin.post('/admin/crm/sync');
    crm.listings = [listing(7)];
    const r = await admin.post('/admin/crm/sync');
    expect(r.body).toMatchObject({ updated: 1 });
    expect(await prisma.property.findUniqueOrThrow({ where: { crmRef: 'dq:7' } })).toMatchObject({ lat: null, lng: null });
  });

  it("keeps a CRM listing's pin when an admin edits the property here", async () => {
    crm.listings = [listing(7, { lat: -1.259094, lng: 36.782915 })];
    await admin.post('/admin/crm/sync');
    const p = await prisma.property.findUniqueOrThrow({ where: { crmRef: 'dq:7' } });
    const r = await admin.req('PUT', `/properties/${p.id}`, { ref: p.ref, crmRef: p.crmRef, address: 'Atreus Brookside, Brookside Drive', service: 'SALES', status: 'ACTIVE', lat: -1.3, lng: 36.7 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ address: 'Atreus Brookside, Brookside Drive', lat: -1.259094, lng: 36.782915 });
    // Our own properties are still pinned here.
    const own = await admin.req('PUT', `/properties/${s.property.id}`, { ref: 'S-1', crmRef: 'CRM-1', address: 'Villa, Lavington', service: 'SALES', status: 'ACTIVE', lat: -1.28, lng: 36.77 });
    expect(own.body).toMatchObject({ lat: -1.28, lng: 36.77 });
  });

  it('reports a reference clash instead of failing the whole sync', async () => {
    await prisma.property.create({ data: { ref: 'DQ-7', address: 'Someone else', service: 'SALES' } });
    const r = await admin.post('/admin/crm/sync');
    expect(r.body).toMatchObject({ created: 1 });
    expect(r.body.errors).toEqual([{ ref: 'dq:7', error: 'Reference DQ-7 is already used by another property' }]);
  });
});
