import { describe, expect, it } from 'vitest';
import {
  crmDealClient,
  crmDealOwnerProperty,
  CrmDealSchema,
  crmDealRawRow,
  crmDealToClosureRow,
  crmListingToProperty,
  crmViewings,
  crmViewingStatus,
  type CrmDeal,
  type CrmListing,
  type CrmViewingBooking,
} from './crm';
import { matchClosureRow, parseClosureRow } from './imports';

const listing = (over: Partial<CrmListing> = {}): CrmListing => ({
  ref: 'dq:42',
  id: 42,
  title: '3 Bedroom Apartment',
  listing_type: 'SALE',
  status: 'AVAILABLE',
  active: true,
  location_text: 'Parklands',
  lat: null,
  lng: null,
  location_note: null,
  ...over,
});

describe('crmListingToProperty', () => {
  it('keys on the CRM ref and gives new rows a DQ- reference', () => {
    expect(crmListingToProperty(listing())).toMatchObject({ crmRef: 'dq:42', ref: 'DQ-42', service: 'SALES', status: 'ACTIVE' });
  });

  it('maps lettings', () => {
    expect(crmListingToProperty(listing({ listing_type: 'LET' })).service).toBe('LETTINGS');
  });

  it('keeps sold and let even when the website has dropped them', () => {
    expect(crmListingToProperty(listing({ status: 'SOLD', active: false })).status).toBe('SOLD');
    expect(crmListingToProperty(listing({ status: 'LET_OUT', active: false })).status).toBe('LET');
  });

  it('withdraws a listing the CRM no longer shows', () => {
    expect(crmListingToProperty(listing({ active: false })).status).toBe('WITHDRAWN');
    expect(crmListingToProperty(listing({ status: 'ON_ENQUIRY' })).status).toBe('ACTIVE');
  });

  it('adds the area to the address only when the title lacks it', () => {
    expect(crmListingToProperty(listing()).address).toBe('3 Bedroom Apartment, Parklands');
    expect(crmListingToProperty(listing({ title: '3 Bed, Parklands Rd' })).address).toBe('3 Bed, Parklands Rd');
    expect(crmListingToProperty(listing({ location_text: null })).address).toBe('3 Bedroom Apartment');
  });

  it('copies the pin agents set in the CRM, and only a whole one', () => {
    expect(crmListingToProperty(listing({ lat: -1.2591, lng: 36.7829 }))).toMatchObject({ lat: -1.2591, lng: 36.7829 });
    expect(crmListingToProperty(listing())).toMatchObject({ lat: null, lng: null });
    expect(crmListingToProperty(listing({ lat: -1.2591 }))).toMatchObject({ lat: null, lng: null });
  });

  it('treats a listing without status (from a lead) as active', () => {
    const { status, active, ...bare } = listing();
    expect(crmListingToProperty(bare).status).toBe('ACTIVE');
  });
});

describe('crmViewingStatus', () => {
  it('follows a booking from request to visit', () => {
    expect(crmViewingStatus('PENDING', 'PLANNED')).toBe('REQUESTED');
    expect(crmViewingStatus('APPROVED', 'PLANNED')).toBe('BOOKED');
    expect(crmViewingStatus('IN_PROGRESS', 'PLANNED')).toBe('BOOKED');
    expect(crmViewingStatus('IN_PROGRESS', 'ARRIVED')).toBe('ARRIVED');
    expect(crmViewingStatus('IN_PROGRESS', 'DEPARTED')).toBe('VISITED');
  });

  it('counts an arrival with no departure as a visit once the trip is over', () => {
    expect(crmViewingStatus('COMPLETED', 'ARRIVED')).toBe('VISITED');
    expect(crmViewingStatus('AWAITING_ODOMETER', 'ARRIVED')).toBe('VISITED');
  });

  it('does not claim a visit the trip never recorded', () => {
    expect(crmViewingStatus('COMPLETED', 'PLANNED')).toBe('UNCONFIRMED');
  });

  it('cancels with the booking, and for a join request that was never approved', () => {
    for (const b of ['REJECTED', 'CANCELLED', 'NO_SHOW'] as const) expect(crmViewingStatus(b, 'PLANNED')).toBe('CANCELLED');
    expect(crmViewingStatus('APPROVED', 'REJECTED')).toBe('CANCELLED');
    expect(crmViewingStatus('APPROVED', 'PROPOSED')).toBe('REQUESTED');
    expect(crmViewingStatus('COMPLETED', 'PROPOSED')).toBe('CANCELLED');
  });

  it('keeps a skipped stop skipped', () => {
    expect(crmViewingStatus('IN_PROGRESS', 'SKIPPED')).toBe('SKIPPED');
    expect(crmViewingStatus('COMPLETED', 'SKIPPED')).toBe('SKIPPED');
  });
});

describe('crmViewings', () => {
  const at = (hhmm: string) => new Date(`2026-11-03T${hhmm}:00Z`);
  const stop = (seq: number, over: Partial<CrmViewingBooking['stops'][number]> = {}): CrmViewingBooking['stops'][number] => ({
    id: `s${seq}`,
    seq,
    status: 'PLANNED',
    crmLeadRef: null,
    address: `Stop ${seq}`,
    arrivedAt: null,
    departedAt: null,
    reason: { label: 'Sales viewing', countsAsViewing: true },
    propertyCrmRef: null,
    ...over,
  });
  const booking = (over: Partial<CrmViewingBooking> = {}): CrmViewingBooking => ({
    status: 'APPROVED',
    startAt: at('09:00'),
    ownerEmail: ' Jane@Test.ke ',
    trip: null,
    stops: [stop(1, { crmLeadRef: '42', propertyCrmRef: 'dq:7', address: 'Listing 7, Parklands' }), stop(2)],
    ...over,
  });

  it('sends only the stops booked for a CRM lead, in route order', () => {
    const b = booking({ stops: [stop(3, { crmLeadRef: '43' }), stop(1, { crmLeadRef: '42' }), stop(2)] });
    expect(crmViewings(b, 'EQUAL').map((v) => [v.stop_id, v.lead_id])).toEqual([['s1', 42], ['s3', 43]]);
  });

  it('names the listing, the agent and the time, and leaves km until the trip ends', () => {
    expect(crmViewings(booking(), 'EQUAL')).toEqual([
      {
        stop_id: 's1',
        lead_id: 42,
        property_ref: 'dq:7',
        place: 'Listing 7, Parklands',
        agent_email: 'jane@test.ke',
        reason: 'Sales viewing',
        counts_as_viewing: true,
        status: 'BOOKED',
        scheduled_at: '2026-11-03T09:00:00.000Z',
        arrived_at: null,
        departed_at: null,
        car_km: null,
      },
    ]);
  });

  it("only passes on the CRM's own listing refs, and ignores a lead ref that is not an id", () => {
    const b = booking({ stops: [stop(1, { crmLeadRef: '42', propertyCrmRef: 'CRM-1' }), stop(2, { crmLeadRef: 'abc' }), stop(3, { crmLeadRef: '0' })] });
    const out = crmViewings(b, 'EQUAL');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ property_ref: null, place: 'Stop 1' });
  });

  it("splits the trip's km over the stops that happened, by the configured rule", () => {
    const trip = { startedAt: at('09:00'), endedAt: at('12:00'), odometerStart: 1000, odometerEnd: 1030 };
    const stops = [
      stop(1, { crmLeadRef: '42', status: 'DEPARTED', arrivedAt: at('09:30'), departedAt: at('10:30') }),
      stop(2, { status: 'DEPARTED', arrivedAt: at('11:00'), departedAt: at('11:30') }),
      stop(3, { crmLeadRef: '44', status: 'SKIPPED' }),
    ];
    const b = booking({ status: 'COMPLETED', trip, stops });
    expect(crmViewings(b, 'EQUAL').map((v) => [v.status, v.car_km])).toEqual([['VISITED', 15], ['SKIPPED', null]]);
    expect(crmViewings(b, 'DWELL_TIME')[0]!.car_km).toBe(20);
  });
});

const deal = (over: Partial<CrmDeal> = {}): CrmDeal => ({
  ref: 'dqd:5',
  id: 5,
  lead_id: 42,
  deal_type: 'SALE',
  signed_on: '2026-11-06',
  fee_kes: 150_000,
  agent_email: ' Jane@Test.ke ',
  property_ref: 'dq:7',
  owner: null,
  owner_property: null,
  voided: false,
  ...over,
});

const owner = (over: Partial<CrmDeal> = {}) =>
  deal({
    deal_type: 'MANAGEMENT',
    property_ref: null,
    owner: { ref: 'dql:42', name: 'Olu Owner' },
    owner_property: { ref: 'dqo:42', name: 'Riverside Court', location_text: 'Kileleshwa', property_type: 'APARTMENT' },
    ...over,
  });

describe('CRM deals', () => {
  it('reads what the CRM sends, and refuses a ref that is not a deal', () => {
    expect(CrmDealSchema.parse({ ...deal(), extra: 'ignored' }).ref).toBe('dqd:5');
    expect(() => CrmDealSchema.parse({ ...deal(), ref: '5' })).toThrow();
    expect(() => CrmDealSchema.parse({ ...deal(), signed_on: '6 Nov' })).toThrow();
  });

  it('makes a sale a closure row that matches like a CSV one', () => {
    const row = crmDealToClosureRow(deal())!;
    expect(row).toEqual({ propertyCrmRef: 'dq:7', staffEmail: 'jane@test.ke', closedAt: new Date('2026-11-06T00:00:00Z'), dealType: 'SALE', fee: 150_000, dealRef: 'dqd:5' });
    const m = matchClosureRow(row, new Map([['dq:7', { id: 'p7' }]]), new Map([['jane@test.ke', { id: 'u1' }]]));
    expect(m).toMatchObject({ status: 'MATCHED', propertyId: 'p7', staffId: 'u1' });
  });

  it("counts a management contract as a closure on the owner's property", () => {
    expect(crmDealToClosureRow(owner())).toMatchObject({ dealType: 'MANAGEMENT', propertyCrmRef: 'dqo:42' });
  });

  it('does not count an instruction to sell or let until it sells or lets', () => {
    expect(crmDealToClosureRow(owner({ deal_type: 'SALE_INSTRUCTION' }))).toBeNull();
    expect(crmDealToClosureRow(owner({ deal_type: 'LET_INSTRUCTION' }))).toBeNull();
  });

  it('leaves an unknown fee and agent unknown, so the deal waits in review', () => {
    const row = crmDealToClosureRow(deal({ fee_kes: null, agent_email: null }))!;
    expect(row.fee).toBeNull();
    expect(matchClosureRow(row, new Map([['dq:7', { id: 'p7' }]]), new Map()).problems).toEqual(['No staff email']);
  });

  it('writes a review row the resolve form reads back as the same closure', () => {
    const raw = crmDealRawRow(deal());
    expect(raw.source).toBe('CRM');
    expect(parseClosureRow(raw)).toEqual({ ...crmDealToClosureRow(deal()), closedAt: parseClosureRow(raw).closedAt });
    expect(parseClosureRow(raw).closedAt?.toISOString().slice(0, 10)).toBe('2026-11-06');
  });

  it('makes the owner a client, and only for owner deals', () => {
    expect(crmDealClient(owner())).toEqual({ crmRef: 'dql:42', name: 'Olu Owner', type: 'LANDLORD' });
    expect(crmDealClient(owner({ deal_type: 'SALE_INSTRUCTION' }))?.type).toBe('VENDOR');
    expect(crmDealClient(deal({ owner: { ref: 'dql:1', name: 'A Buyer' } }))).toBeNull();
  });

  it("describes an owner's unlisted property, waiting for a pin", () => {
    expect(crmDealOwnerProperty(owner())).toEqual({
      crmRef: 'dqo:42', ref: 'DQO-42', address: 'Riverside Court, Kileleshwa', service: 'MANAGEMENT', status: 'ACTIVE', lat: null, lng: null,
    });
    expect(crmDealOwnerProperty(owner({ deal_type: 'LET_INSTRUCTION' }))?.service).toBe('LETTINGS');
    const bare = owner({ owner_property: { ref: 'dqo:42', name: null, location_text: null, property_type: null } });
    expect(crmDealOwnerProperty(bare)?.address).toBe("Olu Owner's property");
    expect(crmDealOwnerProperty(deal())).toBeNull();
  });
});
