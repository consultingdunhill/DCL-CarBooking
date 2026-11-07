// The Dunhill CRM (the lead-capture app at marketing.erp.dunhill-ticketing.com) and how
// its records map onto ours. The CRM owns leads and website listings; Fleet owns trips.
import { z } from 'zod';
import { dwellHours, stopShares, STOPS_THAT_HAPPENED } from './costs';
import type { BookingStatus, ClientType, DealType, PropertyService, PropertyStatus, StopCostSplit, StopStatus } from './enums';
import type { ClosureRow } from './imports';

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

// ── Viewings, pushed back to the CRM ──────────────────────────────────────────

/**
 * How a visit booked for a CRM lead reads on that lead. UNCONFIRMED is a trip that ended
 * with no arrival recorded at the stop: it probably happened, but GPS and the agent are silent.
 */
export const CRM_VIEWING_STATUSES = ['REQUESTED', 'BOOKED', 'ARRIVED', 'VISITED', 'SKIPPED', 'UNCONFIRMED', 'CANCELLED'] as const;
export type CrmViewingStatus = (typeof CRM_VIEWING_STATUSES)[number];

const TRIP_OVER: BookingStatus[] = ['COMPLETED', 'AWAITING_ODOMETER'];
const CALLED_OFF: BookingStatus[] = ['REJECTED', 'CANCELLED', 'NO_SHOW'];

export function crmViewingStatus(booking: BookingStatus, stop: StopStatus): CrmViewingStatus {
  if (CALLED_OFF.includes(booking) || stop === 'REJECTED') return 'CANCELLED';
  if (stop === 'SKIPPED') return 'SKIPPED';
  if (stop === 'DEPARTED') return 'VISITED';
  const over = TRIP_OVER.includes(booking);
  if (stop === 'ARRIVED') return over ? 'VISITED' : 'ARRIVED';
  // A join request's stop that was never approved simply did not happen.
  if (over) return stop === 'PROPOSED' ? 'CANCELLED' : 'UNCONFIRMED';
  return booking === 'PENDING' || stop === 'PROPOSED' ? 'REQUESTED' : 'BOOKED';
}

/** One stop as the CRM stores it, keyed by our stop id. Field names are the CRM's. */
export interface CrmViewing {
  stop_id: string;
  lead_id: number;
  /** "dq:<id>" when the stop is one of the CRM's own listings. */
  property_ref: string | null;
  /** The stop's address: a listing's title and area, or wherever the errand was. */
  place: string;
  /** The trip owner, matched to a CRM agent by work email. */
  agent_email: string | null;
  reason: string;
  counts_as_viewing: boolean;
  status: CrmViewingStatus;
  scheduled_at: string;
  arrived_at: string | null;
  departed_at: string | null;
  /** This stop's share of the trip's odometer km, once the trip has ended. */
  car_km: number | null;
}

export interface CrmViewingBooking {
  status: BookingStatus;
  startAt: Date;
  ownerEmail: string | null;
  trip: { startedAt: Date; endedAt: Date | null; odometerStart: number; odometerEnd: number | null } | null;
  stops: {
    id: string;
    seq: number;
    status: StopStatus;
    crmLeadRef: string | null;
    address: string;
    arrivedAt: Date | null;
    departedAt: Date | null;
    reason: { label: string; countsAsViewing: boolean };
    propertyCrmRef: string | null;
  }[];
}

/**
 * Everything the CRM should show for one booking: its stops that are for a CRM lead. The
 * whole set goes each time, so a stop that loses its lead drops off the CRM too. The km
 * split follows the stopCostSplit setting, the same as the cost reports.
 */
export function crmViewings(b: CrmViewingBooking, split: StopCostSplit): CrmViewing[] {
  const km = new Map<string, number>();
  const t = b.trip;
  if (t?.endedAt && t.odometerEnd != null) {
    const happened = b.stops.filter((s) => STOPS_THAT_HAPPENED.includes(s.status)).sort((a, z) => a.seq - z.seq);
    const shares = stopShares(split, happened.map((s) => dwellHours(s, t.startedAt, t.endedAt!)));
    happened.forEach((s, i) => km.set(s.id, Math.round((t.odometerEnd! - t.odometerStart) * shares[i]! * 10) / 10));
  }

  return b.stops
    .filter((s) => /^[1-9]\d*$/.test(s.crmLeadRef ?? ''))
    .sort((a, z) => a.seq - z.seq)
    .map((s) => ({
      stop_id: s.id,
      lead_id: Number(s.crmLeadRef),
      property_ref: s.propertyCrmRef?.startsWith(CRM_PROPERTY_PREFIX) ? s.propertyCrmRef : null,
      place: s.address,
      agent_email: b.ownerEmail?.trim().toLowerCase() || null,
      reason: s.reason.label,
      counts_as_viewing: s.reason.countsAsViewing,
      status: crmViewingStatus(b.status, s.status),
      scheduled_at: b.startAt.toISOString(),
      arrived_at: s.arrivedAt?.toISOString() ?? null,
      departed_at: s.departedAt?.toISOString() ?? null,
      car_km: km.get(s.id) ?? null,
    }));
}

// ── Deals, pulled from the CRM as closures ────────────────────────────────────

/** Prefixes of the refs the CRM gives deals, owners and owners' unlisted properties. */
export const CRM_DEAL_PREFIX = 'dqd:';
export const CRM_OWNER_PREFIX = 'dql:';
export const CRM_OWNER_PROPERTY_PREFIX = 'dqo:';

export const CRM_DEAL_TYPES = ['SALE', 'LETTING', 'MANAGEMENT', 'SALE_INSTRUCTION', 'LET_INSTRUCTION'] as const;
export type CrmDealType = (typeof CRM_DEAL_TYPES)[number];

export const CrmDealSchema = z.object({
  ref: z.string().startsWith(CRM_DEAL_PREFIX),
  id: z.number().int(),
  lead_id: z.number().int(),
  deal_type: z.enum(CRM_DEAL_TYPES),
  /** A calendar day in Nairobi, YYYY-MM-DD. */
  signed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fee_kes: z.number().nonnegative().nullable(),
  agent_email: z.string().nullable(),
  property_ref: z.string().startsWith(CRM_PROPERTY_PREFIX).nullable(),
  owner: z.object({ ref: z.string().startsWith(CRM_OWNER_PREFIX), name: z.string().min(1) }).nullable(),
  owner_property: z
    .object({
      ref: z.string().startsWith(CRM_OWNER_PROPERTY_PREFIX),
      name: z.string().nullable(),
      location_text: z.string().nullable(),
      property_type: z.string().nullable(),
    })
    .nullable(),
  voided: z.boolean(),
});
export type CrmDeal = z.infer<typeof CrmDealSchema>;

/**
 * The closure a deal makes here. An instruction to sell or let is not one yet: it
 * becomes a closure when the property sells or lets, which the CRM records as its own deal.
 */
export function crmDealClosureType(t: CrmDealType): DealType | null {
  return t === 'SALE' || t === 'LETTING' || t === 'MANAGEMENT' ? t : null;
}

/** The property a deal is on: one of the CRM's listings, or the owner's own property. */
export const crmDealPropertyRef = (d: Pick<CrmDeal, 'property_ref' | 'owner_property'>) => d.property_ref ?? d.owner_property?.ref ?? null;

/** A deal as a closures-import row, so it goes through the same matching as the CSV. */
export function crmDealToClosureRow(d: CrmDeal): ClosureRow | null {
  const dealType = crmDealClosureType(d.deal_type);
  if (!dealType) return null;
  return {
    propertyCrmRef: crmDealPropertyRef(d),
    staffEmail: d.agent_email?.trim().toLowerCase() || null,
    closedAt: new Date(`${d.signed_on}T00:00:00Z`),
    dealType,
    fee: d.fee_kes,
    dealRef: d.ref,
  };
}

/** The same deal in the CSV template's columns: what the review queue shows and re-reads. */
export function crmDealRawRow(d: CrmDeal): Record<string, string> {
  return {
    property_crm_reference: crmDealPropertyRef(d) ?? '',
    staff_email: d.agent_email?.trim().toLowerCase() ?? '',
    closed_at: d.signed_on,
    deal_type: crmDealClosureType(d.deal_type) ?? '',
    fee: d.fee_kes == null ? '' : String(d.fee_kes),
    deal_reference: d.ref,
    source: 'CRM',
  };
}

const OWNER_CLIENT_TYPE: Record<Exclude<CrmDealType, 'SALE' | 'LETTING'>, ClientType> = {
  MANAGEMENT: 'LANDLORD',
  SALE_INSTRUCTION: 'VENDOR',
  LET_INSTRUCTION: 'LANDLORD',
};

const OWNER_SERVICE: Record<Exclude<CrmDealType, 'SALE' | 'LETTING'>, PropertyService> = {
  MANAGEMENT: 'MANAGEMENT',
  SALE_INSTRUCTION: 'SALES',
  LET_INSTRUCTION: 'LETTINGS',
};

/** The owner who signed, as a client of ours. Null for a buyer or tenant. */
export function crmDealClient(d: CrmDeal): { crmRef: string; name: string; type: ClientType } | null {
  if (!d.owner || d.deal_type === 'SALE' || d.deal_type === 'LETTING') return null;
  return { crmRef: d.owner.ref, name: d.owner.name.trim(), type: OWNER_CLIENT_TYPE[d.deal_type] };
}

/**
 * The owner's property when it is not one of the CRM's listings. It has no pin yet, so it
 * waits for an admin's review like a property staff add while booking.
 */
export function crmDealOwnerProperty(d: CrmDeal): CrmPropertyFields | null {
  const p = d.owner_property;
  if (!p || d.deal_type === 'SALE' || d.deal_type === 'LETTING') return null;
  const name = p.name?.trim();
  const where = p.location_text?.trim();
  return {
    crmRef: p.ref,
    ref: `DQO-${p.ref.slice(CRM_OWNER_PROPERTY_PREFIX.length)}`,
    address: [name, where && !name?.toLowerCase().includes(where.toLowerCase()) ? where : null].filter(Boolean).join(', ') || `${d.owner?.name ?? 'Owner'}'s property`,
    service: OWNER_SERVICE[d.deal_type],
    status: 'ACTIVE',
    lat: null,
    lng: null,
  };
}
