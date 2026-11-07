/**
 * The Dunhill CRM link, against a fake CRM: "Book a car" on a lead fills in a booking,
 * the nightly sync mirrors the CRM's portfolio without trampling our own edits, and
 * viewings go back to the CRM as they change.
 */
import { CrmUnavailable, env, pushCrmViewings, stopBoss, syncCrmDeals } from '@carbooking/server';
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

const deal = (id: number, over: Record<string, unknown> = {}) => ({
  ref: `dqd:${id}`, id, lead_id: 40 + id, deal_type: 'SALE', signed_on: '2026-11-06', fee_kes: 150_000 as number | null,
  agent_email: 'JANE@test.ke' as string | null, property_ref: 'dq:7' as string | null,
  owner: null as { ref: string; name: string } | null,
  owner_property: null as { ref: string; name: string | null; location_text: string | null; property_type: string | null } | null,
  voided: false, updated_at: '2026-11-06T10:00:00Z', ...over,
});

/** What the fake CRM holds; each test edits it. */
let crm: {
  listings: ReturnType<typeof listing>[];
  leads: Record<number, unknown>;
  down: boolean;
  /** Viewings received, by booking id: the last set each booking sent. */
  viewings: Record<string, any[]>;
  /** Booking ids the CRM answers 422 for. */
  refuse: Set<string>;
  deals: ReturnType<typeof deal>[];
};
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
    viewings: {},
    refuse: new Set(),
    deals: [],
  };
  seen.length = 0;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url: url.toString(), auth: new Headers(init?.headers).get('authorization') });
    if (crm.down) throw new TypeError('fetch failed');
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/integrations/fleet/properties') return json(200, { properties: crm.listings });
    if (url.pathname === '/api/integrations/fleet/deals') return json(200, { deals: crm.deals });
    const lead = url.pathname.match(/^\/api\/integrations\/fleet\/leads\/(\d+)$/);
    if (lead) return crm.leads[Number(lead[1])] ? json(200, crm.leads[Number(lead[1])]) : json(404, { detail: 'Not found' });
    const viewings = url.pathname.match(/^\/api\/integrations\/fleet\/bookings\/([\w-]+)\/viewings$/);
    if (viewings && init?.method === 'PUT') {
      if (crm.refuse.has(viewings[1]!)) return json(422, { detail: 'refused' });
      crm.viewings[viewings[1]!] = JSON.parse(String(init.body)).viewings;
      return json(200, { upserted: crm.viewings[viewings[1]!]!.length, removed: 0 });
    }
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
      expect((await admin.post('/admin/crm/sync-deals')).status).toBe(404);
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

describe('viewings pushed to the CRM', () => {
  /** A booking by Jane with one stop for lead 42 at listing 7, and one errand. */
  async function bookForLead() {
    const { body: lead } = await jane.get('/crm/leads/42');
    const p = lead.properties[0];
    const start = new Date(Math.ceil((Date.now() + 2 * 3600_000) / 900_000) * 900_000);
    const r = await jane.post('/bookings', {
      carId: s.car1.id,
      startAt: start.toISOString(),
      expectedReturnAt: new Date(start.getTime() + 2 * 3600_000).toISOString(),
      stops: [
        { address: p.address, lat: -1.26, lng: 36.81, propertyId: p.id, reasonId: s.viewing.id, crmLeadRef: lead.ref, crmLeadName: lead.firstName },
        { address: 'Errand', lat: -1.27, lng: 36.8, reasonId: s.errand.id },
      ],
    });
    expect(r.status).toBe(201);
    return r.body.id as string;
  }
  const puts = () => seen.filter((x) => x.url.includes('/viewings')).length;

  it('sends each change once, as the booking moves along', async () => {
    const id = await bookForLead();
    expect(await pushCrmViewings()).toEqual({ pushed: 1, failed: [] });
    expect(crm.viewings[id]).toEqual([
      expect.objectContaining({ lead_id: 42, property_ref: 'dq:7', agent_email: 'jane@test.ke', counts_as_viewing: true, status: 'REQUESTED', car_km: null }),
    ]);
    expect(seen.find((x) => x.url.includes('/viewings'))?.auth).toBe(`Bearer ${env.CRM_API_TOKEN}`);

    // Nothing changed: nothing sent.
    expect((await pushCrmViewings()).pushed).toBe(0);
    expect(puts()).toBe(1);

    await admin.post(`/bookings/${id}/approve`);
    await pushCrmViewings();
    expect(crm.viewings[id]![0].status).toBe('BOOKED');

    await jane.post(`/bookings/${id}/cancel`, { reason: 'Client postponed' });
    await pushCrmViewings();
    expect(crm.viewings[id]![0].status).toBe('CANCELLED');
    expect(puts()).toBe(3);
  });

  it('tells the CRM when a stop no longer belongs to a lead', async () => {
    const id = await bookForLead();
    await pushCrmViewings();
    await prisma.bookingStop.updateMany({ where: { bookingId: id }, data: { crmLeadRef: null, crmLeadName: null } });
    expect((await pushCrmViewings()).pushed).toBe(1);
    expect(crm.viewings[id]).toEqual([]);
  });

  it('leaves bookings with no CRM lead alone', async () => {
    const id = await bookForLead();
    await prisma.bookingStop.updateMany({ where: { bookingId: id }, data: { crmLeadRef: null, crmLeadName: null } });
    expect((await pushCrmViewings()).pushed).toBe(0);
    expect(puts()).toBe(0);
  });

  it('stops the run while the CRM is down, then catches up', async () => {
    const id = await bookForLead();
    crm.down = true;
    await expect(pushCrmViewings()).rejects.toBeInstanceOf(CrmUnavailable);
    expect(await prisma.crmViewingPush.count()).toBe(0);
    crm.down = false;
    expect((await pushCrmViewings()).pushed).toBe(1);
    expect(crm.viewings[id]).toHaveLength(1);
  });

  it('skips a booking the CRM refuses, without holding up the rest', async () => {
    const refused = await bookForLead();
    const other = await bookForLead();
    crm.refuse.add(refused);
    const r = await pushCrmViewings();
    expect(r.pushed).toBe(1);
    expect(r.failed).toEqual([{ bookingId: refused, error: expect.stringContaining('refused') }]);
    expect(crm.viewings[other]).toHaveLength(1);
    // Refused stays unrecorded, so it is tried again next time.
    crm.refuse.clear();
    expect((await pushCrmViewings()).pushed).toBe(1);
  });

  it('does nothing when the link is not configured', async () => {
    await bookForLead();
    const saved = env.CRM_API_URL;
    env.CRM_API_URL = undefined;
    try {
      expect(await pushCrmViewings()).toEqual({ pushed: 0, failed: [] });
    } finally {
      env.CRM_API_URL = saved;
    }
  });
});

describe('signed deals', () => {
  const closureFor = (ref: string) => prisma.closure.findUnique({ where: { crmRef: ref } });

  it('become closures, follow corrections in the CRM, and go when voided there', async () => {
    crm.deals = [deal(1)];
    expect((await jane.post('/admin/crm/sync-deals')).status).toBe(403);

    let r = await admin.post('/admin/crm/sync-deals');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deals: 1, created: 1, awaitingReview: 0 });
    const listing7 = await prisma.property.findUniqueOrThrow({ where: { crmRef: 'dq:7' } }); // synced first
    expect(await closureFor('dqd:1')).toMatchObject({
      propertyId: listing7.id, staffId: s.jane.id, dealType: 'SALE', closedAt: new Date('2026-11-06T09:00:00Z'),
    });
    expect(Number((await closureFor('dqd:1'))!.fee)).toBe(150_000);
    // Whether it is sold is the CRM's to say, through the portfolio sync.
    expect((await prisma.property.findUniqueOrThrow({ where: { id: listing7.id } })).status).toBe('ACTIVE');

    expect((await admin.post('/admin/crm/sync-deals')).body).toMatchObject({ created: 0, unchanged: 1 });

    crm.deals = [deal(1, { fee_kes: 175_000, signed_on: '2026-11-05' })];
    expect((await admin.post('/admin/crm/sync-deals')).body).toMatchObject({ updated: 1 });
    expect(Number((await closureFor('dqd:1'))!.fee)).toBe(175_000);

    crm.deals = [deal(1, { voided: true })];
    expect((await admin.post('/admin/crm/sync-deals')).body).toMatchObject({ removed: 1 });
    expect(await closureFor('dqd:1')).toBeNull();

    const last = await admin.get('/admin/crm/last-sync');
    expect(last.body.deals).toMatchObject({ summary: { removed: 1 } });
  });

  it('wait in review once, and match by themselves when the work email turns up', async () => {
    crm.deals = [deal(2, { agent_email: 'new.agent@test.ke' })];
    expect((await admin.post('/admin/crm/sync-deals')).body).toMatchObject({ created: 0, awaitingReview: 1 });
    expect((await admin.post('/admin/crm/sync-deals')).body).toMatchObject({ awaitingReview: 1 });
    const queue = await admin.get('/admin/closures/review');
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({ raw: { source: 'CRM', deal_reference: 'dqd:2' }, problems: ['Unknown staff email "new.agent@test.ke"'] });

    await prisma.user.create({ data: { name: 'New Agent', email: 'new.agent@test.ke' } });
    expect((await admin.post('/admin/crm/sync-deals')).body).toMatchObject({ created: 1, resolved: 1, awaitingReview: 0 });
    const row = await prisma.closureImportRow.findUniqueOrThrow({ where: { crmDealRef: 'dqd:2' } });
    expect(row).toMatchObject({ status: 'RESOLVED', closureId: (await closureFor('dqd:2'))!.id });
    expect((await admin.get('/admin/closures/review')).body).toHaveLength(0);
  });

  it("keep an admin's choices for what the CRM can't name, and stay ignored once ignored", async () => {
    crm.deals = [deal(3, { agent_email: null, property_ref: 'dq:99' }), deal(4, { agent_email: null })];
    await admin.post('/admin/crm/sync-deals');
    const rows = await prisma.closureImportRow.findMany({ where: { crmDealRef: { not: null } }, orderBy: { crmDealRef: 'asc' } });
    expect(rows.map((r) => r.crmDealRef)).toEqual(['dqd:3', 'dqd:4']);

    const resolved = await admin.post(`/admin/closures/rows/${rows[0]!.id}/resolve`, { propertyId: s.property.id, staffId: s.tom.id });
    expect(resolved.status).toBe(200);
    expect((await admin.post(`/admin/closures/rows/${rows[1]!.id}/resolve`, { ignore: true })).status).toBe(200);

    const r = await admin.post('/admin/crm/sync-deals');
    expect(r.body).toMatchObject({ created: 0, unchanged: 1, awaitingReview: 0 });
    expect(await closureFor('dqd:3')).toMatchObject({ propertyId: s.property.id, staffId: s.tom.id });
    expect(await closureFor('dqd:4')).toBeNull();
    expect((await prisma.closureImportRow.findUniqueOrThrow({ where: { crmDealRef: 'dqd:4' } })).status).toBe('IGNORED');
  });

  it('make owners clients, count a management contract, and leave instructions for later', async () => {
    crm.deals = [
      deal(5, {
        deal_type: 'MANAGEMENT', property_ref: null, fee_kes: 90_000, owner: { ref: 'dql:45', name: 'Olu Owner' },
        owner_property: { ref: 'dqo:45', name: 'Riverside Court', location_text: 'Kileleshwa', property_type: 'APARTMENT' },
      }),
      deal(6, { deal_type: 'SALE_INSTRUCTION', property_ref: 'dq:8', fee_kes: null, owner: { ref: 'dql:46', name: 'Vera Vendor' } }),
    ];
    let r = await admin.post('/admin/crm/sync-deals');
    expect(r.body).toMatchObject({ deals: 2, created: 1, clientsCreated: 2, propertiesCreated: 1, errors: [] });

    const riverside = await prisma.property.findUniqueOrThrow({ where: { crmRef: 'dqo:45' }, include: { client: true } });
    expect(riverside).toMatchObject({ ref: 'DQO-45', address: 'Riverside Court, Kileleshwa', service: 'MANAGEMENT', needsReview: true, lat: null });
    expect(riverside.client).toMatchObject({ name: 'Olu Owner', type: 'LANDLORD', crmRef: 'dql:45', phone: null });
    expect(await closureFor('dqd:5')).toMatchObject({ propertyId: riverside.id, dealType: 'MANAGEMENT', staffId: s.jane.id });

    const listing8 = await prisma.property.findUniqueOrThrow({ where: { crmRef: 'dq:8' }, include: { client: true } });
    expect(listing8.client).toMatchObject({ name: 'Vera Vendor', type: 'VENDOR' });
    expect(await closureFor('dqd:6')).toBeNull();

    // The portfolio sync never withdraws an owner's property: it isn't a website listing.
    await admin.post('/admin/crm/sync');
    expect((await prisma.property.findUniqueOrThrow({ where: { id: riverside.id } })).status).toBe('ACTIVE');

    r = await admin.post('/admin/crm/sync-deals');
    expect(r.body).toMatchObject({ created: 0, unchanged: 1, clientsCreated: 0, propertiesCreated: 0 });
  });

  it('runs from the nightly job with nobody behind it', async () => {
    crm.deals = [deal(7, { agent_email: null })];
    await admin.post('/admin/crm/sync'); // the job syncs the portfolio first
    expect(await syncCrmDeals()).toMatchObject({ awaitingReview: 1 });
    const batch = await prisma.closureImportBatch.findFirstOrThrow({ where: { fileName: 'CRM deals sync' } });
    expect(batch).toMatchObject({ uploadedById: null, rowCount: 1, unmatchedCount: 1 });
    expect((await admin.get('/admin/closures/batches')).body[0]).toMatchObject({ fileName: 'CRM deals sync', uploadedBy: null });
  });
});
