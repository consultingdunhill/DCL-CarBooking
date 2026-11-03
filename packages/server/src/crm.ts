import { createHash } from 'node:crypto';
import { CRM_PROPERTY_PREFIX, CrmLeadSchema, CrmListingSchema, crmListingToProperty, crmViewings, DAY, type CrmLead, type CrmListing } from '@carbooking/core';
import { isUniqueViolation, prisma, type Property } from '@carbooking/db';
import { z } from 'zod';
import { audit } from './audit';
import { env } from './env';
import { getSettings } from './settings';

/**
 * The Dunhill CRM. Fleet does all the syncing: the CRM only answers. Its routes are
 * /api/integrations/fleet/* behind a bearer token (FLEET_INTEGRATION_TOKEN there).
 */
export const crmEnabled = () => Boolean(env.CRM_API_URL && env.CRM_API_TOKEN);

export class CrmUnavailable extends Error {}

async function crmFetch(path: string, init: { method?: 'GET' | 'PUT'; body?: unknown } = {}): Promise<Response> {
  if (!crmEnabled()) throw new CrmUnavailable('The CRM link is not set up');
  try {
    return await fetch(new URL(path, env.CRM_API_URL), {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${env.CRM_API_TOKEN}`,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new CrmUnavailable(`The CRM did not answer: ${(err as Error).message}`);
  }
}

async function crmGet<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  const res = await crmFetch(path);
  if (res.status === 404 && path.includes('/leads/')) return null;
  if (!res.ok) throw new CrmUnavailable(`The CRM answered ${res.status}`);
  return schema.parse(await res.json());
}

/** One lead, as much as a booking needs. Null when the CRM has no such lead. */
export function fetchCrmLead(id: number): Promise<CrmLead | null> {
  return crmGet(`/api/integrations/fleet/leads/${id}`, CrmLeadSchema);
}

type ListingLike = Parameters<typeof crmListingToProperty>[0];

const samePin = (p: Pick<Property, 'lat' | 'lng'>, want: { lat: number | null; lng: number | null }) => p.lat === want.lat && p.lng === want.lng;

/**
 * Our Property for each CRM listing, creating any we have not synced yet (a listing added
 * to the website since last night). Existing rows only take the CRM's pin, so a listing
 * an agent pinned a minute ago is placed without waiting for tonight's sync.
 */
export async function ensureCrmProperties(listings: ListingLike[]): Promise<Map<string, Property>> {
  const refs = listings.map((l) => l.ref);
  const found = new Map((await prisma.property.findMany({ where: { crmRef: { in: refs } } })).map((p) => [p.crmRef!, p]));
  for (const l of listings) {
    const have = found.get(l.ref);
    if (have) {
      const { lat, lng } = crmListingToProperty(l);
      if (!samePin(have, { lat, lng })) found.set(l.ref, await prisma.property.update({ where: { id: have.id }, data: { lat, lng } }));
      continue;
    }
    const created = await createFromCrm(l).catch((err) => {
      if (!isUniqueViolation(err)) throw err;
      return null; // a concurrent sync got there first, or the DQ- ref is taken
    });
    const row = created ?? (await prisma.property.findUnique({ where: { crmRef: l.ref } }));
    if (row) found.set(l.ref, row);
  }
  return found;
}

function createFromCrm(l: ListingLike) {
  return prisma.property.create({ data: { ...crmListingToProperty(l), needsReview: false } });
}

export interface CrmSyncSummary {
  listings: number;
  created: number;
  updated: number;
  unchanged: number;
  withdrawn: number;
  errors: { ref: string; error: string }[];
}

/**
 * Pull the CRM's whole portfolio. The CRM owns whether a listing is for sale or to let,
 * whether it is still available, and its map pin (agents set it there by hand); the
 * address and client stay ours to edit.
 */
export async function syncCrmProperties(actorId: string | null = null): Promise<CrmSyncSummary> {
  const body = await crmGet('/api/integrations/fleet/properties', z.object({ properties: z.array(CrmListingSchema) }));
  const listings: CrmListing[] = body!.properties;
  const summary: CrmSyncSummary = { listings: listings.length, created: 0, updated: 0, unchanged: 0, withdrawn: 0, errors: [] };

  const ours = new Map(
    (await prisma.property.findMany({ where: { crmRef: { startsWith: CRM_PROPERTY_PREFIX } } })).map((p) => [p.crmRef!, p]),
  );
  for (const l of listings) {
    const want = crmListingToProperty(l);
    const have = ours.get(l.ref);
    try {
      if (!have) {
        await createFromCrm(l);
        summary.created++;
      } else if (have.service !== want.service || have.status !== want.status || !samePin(have, want)) {
        await prisma.property.update({ where: { id: have.id }, data: { service: want.service, status: want.status, lat: want.lat, lng: want.lng } });
        summary.updated++;
      } else summary.unchanged++;
    } catch (err) {
      summary.errors.push({ ref: l.ref, error: isUniqueViolation(err) ? `Reference ${want.ref} is already used by another property` : (err as Error).message });
    }
  }

  // Deleted in the CRM altogether: withdraw ours, keeping its trip history.
  const seen = new Set(listings.map((l) => l.ref));
  const gone = [...ours.values()].filter((p) => !seen.has(p.crmRef!) && p.status === 'ACTIVE').map((p) => p.id);
  if (gone.length) summary.withdrawn = (await prisma.property.updateMany({ where: { id: { in: gone } }, data: { status: 'WITHDRAWN' } })).count;

  await audit({ actorId, action: 'CRM_PROPERTIES_SYNCED', entity: 'Property', after: { ...summary, errors: summary.errors.slice(0, 50) } });
  return summary;
}

/** How far back the viewings push looks: well past the end of any trip. */
const VIEWINGS_LOOKBACK_DAYS = 30;

export interface CrmViewingsPushSummary {
  pushed: number;
  failed: { bookingId: string; error: string }[];
}

/**
 * Tell the CRM about each booking whose viewings changed since we last did. A booking's
 * whole set goes at once, keyed by our stop ids, so a repeat is harmless and a stop that
 * loses its lead drops off the CRM. Runs every minute: anything that fails goes again on
 * the next run. When the CRM is down or refuses us outright, the run stops at once rather
 * than failing every booking in turn.
 */
export async function pushCrmViewings(now = new Date()): Promise<CrmViewingsPushSummary> {
  const summary: CrmViewingsPushSummary = { pushed: 0, failed: [] };
  if (!crmEnabled()) return summary;
  const { stopCostSplit } = await getSettings();
  const bookings = await prisma.booking.findMany({
    where: {
      startAt: { gte: new Date(now.getTime() - VIEWINGS_LOOKBACK_DAYS * DAY) },
      // Once pushed, keep checking: its last CRM stop may since have lost its lead.
      OR: [{ crmPush: { isNot: null } }, { stops: { some: { crmLeadRef: { not: null } } } }],
    },
    orderBy: { startAt: 'asc' },
    select: {
      id: true,
      status: true,
      startAt: true,
      owner: { select: { email: true } },
      crmPush: { select: { hash: true } },
      trip: { select: { startedAt: true, endedAt: true, odometerStart: true, odometerEnd: true } },
      stops: {
        select: {
          id: true,
          seq: true,
          status: true,
          crmLeadRef: true,
          label: true,
          address: true,
          arrivedAt: true,
          departedAt: true,
          reason: { select: { label: true, countsAsViewing: true } },
          property: { select: { crmRef: true } },
        },
      },
    },
  });

  for (const b of bookings) {
    const viewings = crmViewings(
      {
        status: b.status,
        startAt: b.startAt,
        ownerEmail: b.owner.email,
        trip: b.trip,
        stops: b.stops.map(({ property, ...s }) => ({ ...s, propertyCrmRef: property?.crmRef ?? null })),
      },
      stopCostSplit,
    );
    const hash = createHash('sha256').update(JSON.stringify(viewings)).digest('hex');
    if (hash === b.crmPush?.hash) continue;

    const res = await crmFetch(`/api/integrations/fleet/bookings/${b.id}/viewings`, { method: 'PUT', body: { viewings } });
    if (!res.ok) {
      // 422 is about this booking's data; anything else (401, 404, 5xx) is the link itself.
      if (res.status !== 422) throw new CrmUnavailable(`The CRM answered ${res.status}`);
      summary.failed.push({ bookingId: b.id, error: (await res.text()).slice(0, 500) });
      continue;
    }
    await prisma.crmViewingPush.upsert({
      where: { bookingId: b.id },
      create: { bookingId: b.id, hash, pushedAt: now },
      update: { hash, pushedAt: now },
    });
    summary.pushed++;
  }
  return summary;
}
