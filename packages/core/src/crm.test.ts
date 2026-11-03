import { describe, expect, it } from 'vitest';
import { crmListingToProperty, crmViewings, crmViewingStatus, type CrmListing, type CrmViewingBooking } from './crm';

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
