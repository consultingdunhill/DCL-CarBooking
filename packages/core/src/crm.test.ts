import { describe, expect, it } from 'vitest';
import { crmListingToProperty, type CrmListing } from './crm';

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
