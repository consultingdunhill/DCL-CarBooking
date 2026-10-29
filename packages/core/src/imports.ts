import { CLIENT_TYPES, DEAL_TYPES, PROPERTY_SERVICES, PROPERTY_STATUSES, type ClientType, type DealType, type PropertyService, type PropertyStatus } from './enums';

export type RawRow = Record<string, string | undefined>;

/** 'Property Ref' → 'property_ref'. */
export function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Pick the first non-empty value among header aliases. */
function pick(row: RawRow, aliases: string[]): string | undefined {
  for (const a of aliases) {
    const v = row[a]?.trim();
    if (v) return v;
  }
  return undefined;
}

export function normalizeRow(raw: Record<string, unknown>): RawRow {
  const out: RawRow = {};
  for (const [k, v] of Object.entries(raw)) out[normalizeHeader(k)] = v == null ? undefined : String(v);
  return out;
}

/**
 * Parse a date as written in a CSV: ISO (2026-03-31, 2026-03-31T10:00Z) or
 * day-first (31/03/2026, 31-03-2026), as used in Kenya.
 */
export function parseCsvDate(value: string | undefined): Date | null {
  if (!value) return null;
  const v = value.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (m) {
    const d = new Date(Date.UTC(+m[3]!, +m[2]! - 1, +m[1]!));
    return d.getUTCDate() === +m[1]! ? d : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function parseAmount(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function enumOf<T extends string>(values: readonly T[], value: string | undefined, synonyms: Record<string, T> = {}): T | null {
  if (!value) return null;
  const v = normalizeHeader(value).toUpperCase();
  if ((values as readonly string[]).includes(v)) return v as T;
  return synonyms[v] ?? null;
}

// ── Portfolio (properties + clients) ──────────────────────────────────────────

export interface PortfolioRow {
  ref: string;
  crmRef: string | null;
  address: string;
  service: PropertyService;
  status: PropertyStatus;
  lat: number | null;
  lng: number | null;
  client: {
    name: string;
    type: ClientType;
    phone: string | null;
    email: string | null;
    crmRef: string | null;
  } | null;
}

export const PORTFOLIO_TEMPLATE_HEADERS = [
  'reference',
  'crm_reference',
  'address',
  'service',
  'status',
  'latitude',
  'longitude',
  'client_name',
  'client_type',
  'client_phone',
  'client_email',
  'client_crm_reference',
];

export function parsePortfolioRow(raw: RawRow): { ok: true; row: PortfolioRow } | { ok: false; error: string } {
  const ref = pick(raw, ['reference', 'ref', 'property_ref', 'property_reference']);
  const address = pick(raw, ['address', 'property_address']);
  const service = enumOf(PROPERTY_SERVICES, pick(raw, ['service', 'type', 'department']), {
    SALE: 'SALES',
    LETTING: 'LETTINGS',
    RENTAL: 'LETTINGS',
    RENTALS: 'LETTINGS',
    PROPERTY_MANAGEMENT: 'MANAGEMENT',
  });
  if (!ref) return { ok: false, error: 'Missing reference' };
  if (!address) return { ok: false, error: 'Missing address' };
  if (!service) return { ok: false, error: 'Service must be sales, lettings or management' };
  const status =
    enumOf(PROPERTY_STATUSES, pick(raw, ['status']), { AVAILABLE: 'ACTIVE', ON_MARKET: 'ACTIVE', LET_AGREED: 'LET', SOLD_STC: 'SOLD' }) ?? 'ACTIVE';
  const lat = parseAmount(pick(raw, ['latitude', 'lat']));
  const lng = parseAmount(pick(raw, ['longitude', 'lng', 'lon']));
  const clientName = pick(raw, ['client_name', 'client', 'owner', 'landlord', 'vendor']);
  return {
    ok: true,
    row: {
      ref,
      crmRef: pick(raw, ['crm_reference', 'crm_ref', 'crm_id']) ?? null,
      address,
      service,
      status,
      lat: lat != null && Math.abs(lat) <= 90 ? lat : null,
      lng: lng != null && Math.abs(lng) <= 180 ? lng : null,
      client: clientName
        ? {
            name: clientName,
            type: enumOf(CLIENT_TYPES, pick(raw, ['client_type']), { SELLER: 'VENDOR', OWNER: 'LANDLORD' }) ?? (service === 'SALES' ? 'VENDOR' : 'LANDLORD'),
            phone: pick(raw, ['client_phone', 'phone']) ?? null,
            email: pick(raw, ['client_email', 'email'])?.toLowerCase() ?? null,
            crmRef: pick(raw, ['client_crm_reference', 'client_crm_ref', 'client_crm_id']) ?? null,
          }
        : null,
    },
  };
}

// ── CRM closures ──────────────────────────────────────────────────────────────

export interface ClosureRow {
  propertyCrmRef: string | null;
  staffEmail: string | null;
  closedAt: Date | null;
  dealType: DealType | null;
  fee: number | null;
  dealRef: string | null;
}

export const CLOSURE_TEMPLATE_HEADERS = ['property_crm_reference', 'staff_email', 'closed_at', 'deal_type', 'fee', 'deal_reference'];

export function parseClosureRow(raw: RawRow): ClosureRow {
  return {
    propertyCrmRef: pick(raw, ['property_crm_reference', 'property_crm_ref', 'crm_reference', 'crm_ref', 'property_ref', 'property_reference']) ?? null,
    staffEmail: pick(raw, ['staff_email', 'agent_email', 'negotiator_email', 'email'])?.toLowerCase() ?? null,
    closedAt: parseCsvDate(pick(raw, ['closed_at', 'date_closed', 'closing_date', 'completion_date', 'date'])),
    dealType: enumOf(DEAL_TYPES, pick(raw, ['deal_type', 'type']), { SALES: 'SALE', SOLD: 'SALE', LET: 'LETTING', LETTINGS: 'LETTING', RENTAL: 'LETTING' }),
    fee: parseAmount(pick(raw, ['fee', 'commission', 'fee_kes'])),
    dealRef: pick(raw, ['deal_reference', 'deal_ref', 'deal_id', 'closure_id']) ?? null,
  };
}

export interface ClosureMatch {
  status: 'MATCHED' | 'UNMATCHED';
  propertyId: string | null;
  staffId: string | null;
  problems: string[];
}

/**
 * Match a closures row to a property (by CRM reference) and a staff member (by
 * email). Anything that doesn't match goes to the review queue.
 */
export function matchClosureRow(
  row: ClosureRow,
  propertiesByCrmRef: Map<string, { id: string }>,
  usersByEmail: Map<string, { id: string }>,
): ClosureMatch {
  const problems: string[] = [];
  const property = row.propertyCrmRef ? propertiesByCrmRef.get(row.propertyCrmRef.toLowerCase()) : undefined;
  const staff = row.staffEmail ? usersByEmail.get(row.staffEmail) : undefined;
  if (!row.propertyCrmRef) problems.push('No property CRM reference');
  else if (!property) problems.push(`Unknown property CRM reference "${row.propertyCrmRef}"`);
  if (!row.staffEmail) problems.push('No staff email');
  else if (!staff) problems.push(`Unknown staff email "${row.staffEmail}"`);
  if (!row.closedAt) problems.push('Missing or unreadable closing date');
  if (!row.dealType) problems.push('Deal type must be sale or letting');
  return {
    status: problems.length === 0 ? 'MATCHED' : 'UNMATCHED',
    propertyId: property?.id ?? null,
    staffId: staff?.id ?? null,
    problems,
  };
}
