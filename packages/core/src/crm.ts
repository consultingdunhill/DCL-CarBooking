// The Dunhill CRM (the lead-capture app at marketing.erp.dunhill-ticketing.com) and how
// its records map onto ours. The CRM owns leads and website listings; Fleet owns trips.
import { z } from 'zod';
import type { PropertyService, PropertyStatus } from './enums';

/** Prefix of Property.crmRef for listings that came from the CRM ("dq:42"). */
export const CRM_PROPERTY_PREFIX = 'dq:';

export const CrmListingSchema = z.object({
  ref: z.string().startsWith(CRM_PROPERTY_PREFIX),
  id: z.number().int(),
  title: z.string(),
  listing_type: z.enum(['SALE', 'LET']),
  status: z.enum(['AVAILABLE', 'ON_ENQUIRY', 'SOLD', 'LET_OUT']),
  active: z.boolean(),
  location_text: z.string().nullable(),
  /** The gate, pinned by an agent in the CRM. The CRM owns it: we only copy it. */
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  location_note: z.string().nullable(),
});
export type CrmListing = z.infer<typeof CrmListingSchema>;

export const CrmLeadSchema = z.object({
  id: z.number().int(),
  first_name: z.string(),
  service_type: z.string(),
  service_label: z.string(),
  agent: z.object({ id: z.number().int(), full_name: z.string(), email: z.string().nullable() }).nullable(),
  properties: z.array(
    z.object({
      ref: z.string().startsWith(CRM_PROPERTY_PREFIX),
      id: z.number().int(),
      title: z.string(),
      location_text: z.string().nullable(),
      listing_type: z.enum(['SALE', 'LET']),
      lat: z.number().nullable(),
      lng: z.number().nullable(),
      location_note: z.string().nullable(),
    }),
  ),
});
export type CrmLead = z.infer<typeof CrmLeadSchema>;

export interface CrmPropertyFields {
  crmRef: string;
  /** Our human reference for a new row; never changed once created. */
  ref: string;
  address: string;
  service: PropertyService;
  status: PropertyStatus;
  lat: number | null;
  lng: number | null;
}

/**
 * What a CRM listing means here. Sold and let stay sold and let even once the website
 * drops them; anything else the CRM no longer shows is withdrawn.
 */
export function crmListingToProperty(
  l: Pick<CrmListing, 'ref' | 'id' | 'title' | 'listing_type' | 'location_text' | 'lat' | 'lng'> & Partial<Pick<CrmListing, 'status' | 'active'>>,
): CrmPropertyFields {
  const status: PropertyStatus = l.status === 'SOLD' ? 'SOLD' : l.status === 'LET_OUT' ? 'LET' : l.active === false ? 'WITHDRAWN' : 'ACTIVE';
  const where = l.location_text?.trim();
  return {
    crmRef: l.ref,
    ref: `DQ-${l.id}`,
    // The title often names the street already; the area is only added when it doesn't.
    address: where && !l.title.toLowerCase().includes(where.toLowerCase()) ? `${l.title}, ${where}` : l.title,
    service: l.listing_type === 'LET' ? 'LETTINGS' : 'SALES',
    status,
    // Both or neither: half a pin is no pin.
    ...(l.lat != null && l.lng != null ? { lat: l.lat, lng: l.lng } : { lat: null, lng: null }),
  };
}
