import { createHash } from 'node:crypto';
import {
  CRM_DEAL_PREFIX,
  CRM_PROPERTY_PREFIX,
  crmDealClient,
  crmDealOwnerProperty,
  crmDealRawRow,
  CrmDealSchema,
  crmDealToClosureRow,
  CrmLeadSchema,
  CrmListingSchema,
  crmListingToProperty,
  crmViewings,
  DAY,
  matchClosureRow,
  zonedTimeToUtc,
  type CrmDeal,
  type CrmLead,
  type CrmListing,
} from '@carbooking/core';
import { isUniqueViolation, num, prisma, type Prisma, type Property } from '@carbooking/db';
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

export interface CrmDealsSyncSummary {
  deals: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Closures dropped because their deal was voided, or is gone from the CRM. */
  removed: number;
  /** Deals that could not be matched (no work email, unknown listing): in the review queue. */
  awaitingReview: number;
  /** Deals that waited in review and matched on this run, e.g. once a work email was filled in. */
  resolved: number;
  clientsCreated: number;
  propertiesCreated: number;
  errors: { ref: string; error: string }[];
}

/**
 * The owner as our client, and their property in our portfolio: either the CRM listing
 * they signed for, or their own property, which waits for a pin like any new one.
 */
async function syncDealOwner(d: CrmDeal, summary: CrmDealsSyncSummary): Promise<void> {
  const want = crmDealClient(d);
  if (!want) return;
  let client = await prisma.client.findUnique({ where: { crmRef: want.crmRef } });
  if (!client) {
    client = await prisma.client.create({ data: want });
    summary.clientsCreated++;
  } else if (client.name !== want.name) {
    client = await prisma.client.update({ where: { id: client.id }, data: { name: want.name } });
  }

  const own = crmDealOwnerProperty(d);
  if (own) {
    const have = await prisma.property.findUnique({ where: { crmRef: own.crmRef } });
    if (!have) {
      await prisma.property.create({ data: { ...own, clientId: client.id, needsReview: true } });
      summary.propertiesCreated++;
    } else if (have.clientId !== client.id || have.service !== own.service) {
      // The address is ours to correct once it exists, as with listings.
      await prisma.property.update({ where: { id: have.id }, data: { clientId: client.id, service: own.service } });
    }
  } else if (d.property_ref) {
    // Signed for a listing already on the website: it is theirs, unless an admin said otherwise.
    await prisma.property.updateMany({ where: { crmRef: d.property_ref, clientId: null }, data: { clientId: client.id } });
  }
}

/**
 * Pull the CRM's signed deals as closures. The CRM owns them: a deal corrected there is
 * corrected here, and one voided there is dropped here. Deals go through the same matching
 * as the closures CSV; one that can't be matched waits in the review queue, once, and is
 * matched by itself on a later run when it can be. Property status is left to the
 * property sync, because the CRM owns that too.
 *
 * Run it after syncCrmProperties, so a listing added today is here to match.
 */
export async function syncCrmDeals(actorId: string | null = null): Promise<CrmDealsSyncSummary> {
  const body = await crmGet('/api/integrations/fleet/deals', z.object({ deals: z.array(CrmDealSchema) }));
  const deals: CrmDeal[] = body!.deals;
  const summary: CrmDealsSyncSummary = {
    deals: deals.length, created: 0, updated: 0, unchanged: 0, removed: 0, awaitingReview: 0, resolved: 0,
    clientsCreated: 0, propertiesCreated: 0, errors: [],
  };
  const fail = (ref: string, err: unknown) => summary.errors.push({ ref, error: (err as Error).message.slice(0, 300) });

  // Owners first: a management contract's closure is on the owner's property.
  for (const d of deals) {
    if (!d.voided) await syncDealOwner(d, summary).catch((err) => fail(d.ref, err));
  }

  const { timezone } = await getSettings();
  const [properties, users, closures, reviewRows] = await Promise.all([
    prisma.property.findMany({ where: { crmRef: { not: null } }, select: { id: true, crmRef: true } }),
    prisma.user.findMany({ select: { id: true, email: true } }),
    prisma.closure.findMany({ where: { crmRef: { startsWith: CRM_DEAL_PREFIX } } }),
    prisma.closureImportRow.findMany({ where: { crmDealRef: { not: null } } }),
  ]);
  const byCrm = new Map(properties.map((p) => [p.crmRef!.toLowerCase(), { id: p.id }]));
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), { id: u.id }]));
  const closureFor = new Map(closures.map((c) => [c.crmRef!, c]));
  const reviewFor = new Map(reviewRows.map((r) => [r.crmDealRef!, r]));

  let batch: { id: string; rows: number } | null = null;
  const reviewBatch = async () =>
    (batch ??= {
      id: (await prisma.closureImportBatch.create({
        data: { fileName: 'CRM deals sync', uploadedById: actorId, rowCount: 0, matchedCount: 0, unmatchedCount: 0 },
      })).id,
      rows: 0,
    });

  const live = new Set<string>();
  for (const d of deals) {
    const row = crmDealToClosureRow(d);
    if (d.voided || !row) continue;
    live.add(d.ref);
    try {
      const m = matchClosureRow(row, byCrm, byEmail);
      const closedAt = zonedTimeToUtc(d.signed_on, '12:00', timezone);
      const have = closureFor.get(d.ref);

      if (have) {
        // Corrections flow from the CRM. A property or person it names that we can't match
        // leaves what an admin chose in review; a fee it doesn't know leaves the one we have.
        const data: Prisma.ClosureUncheckedUpdateInput = {
          closedAt,
          dealType: row.dealType!,
          fee: row.fee ?? num(have.fee),
          ...(m.propertyId ? { propertyId: m.propertyId } : {}),
          ...(m.staffId ? { staffId: m.staffId } : {}),
        };
        const same =
          have.closedAt.getTime() === closedAt.getTime() && have.dealType === data.dealType && num(have.fee) === data.fee &&
          (!m.propertyId || have.propertyId === m.propertyId) && (!m.staffId || have.staffId === m.staffId);
        if (same) summary.unchanged++;
        else {
          await prisma.closure.update({ where: { id: have.id }, data });
          summary.updated++;
        }
        continue;
      }

      const review = reviewFor.get(d.ref);
      if (m.status === 'MATCHED') {
        await prisma.$transaction(async (tx) => {
          const c = await tx.closure.create({
            data: { propertyId: m.propertyId!, staffId: m.staffId, closedAt, dealType: row.dealType!, fee: row.fee, crmRef: d.ref, importBatchId: review?.batchId ?? null },
          });
          if (review?.status === 'UNMATCHED') {
            await tx.closureImportRow.update({ where: { id: review.id }, data: { status: 'RESOLVED', problems: [], closureId: c.id } });
          }
        });
        summary.created++;
        if (review?.status === 'UNMATCHED') summary.resolved++;
        continue;
      }

      // Unmatched: one review row per deal, kept up to date. One an admin ignored stays ignored.
      const raw = crmDealRawRow(d) as Prisma.InputJsonValue;
      if (!review) {
        const b = await reviewBatch();
        await prisma.closureImportRow.create({
          data: { batchId: b.id, rowNumber: ++b.rows, raw, status: 'UNMATCHED', problems: m.problems, crmDealRef: d.ref },
        });
        summary.awaitingReview++;
      } else if (review.status === 'UNMATCHED') {
        await prisma.closureImportRow.update({ where: { id: review.id }, data: { raw, problems: m.problems } });
        summary.awaitingReview++;
      }
    } catch (err) {
      fail(d.ref, err);
    }
  }

  // Voided, or gone from the CRM altogether: drop the closure, and stop asking about it.
  for (const [ref, c] of closureFor) {
    if (live.has(ref)) continue;
    await prisma
      .$transaction([
        prisma.closureImportRow.updateMany({ where: { closureId: c.id }, data: { closureId: null, status: 'IGNORED' } }),
        prisma.closure.delete({ where: { id: c.id } }),
      ])
      .then(() => summary.removed++)
      .catch((err) => fail(ref, err));
  }
  await prisma.closureImportRow.updateMany({
    where: { status: 'UNMATCHED', crmDealRef: { not: null, notIn: [...live] } },
    data: { status: 'IGNORED' },
  });

  if (batch) {
    const { id, rows } = batch;
    await prisma.closureImportBatch.update({ where: { id }, data: { rowCount: rows, unmatchedCount: rows } });
  }
  await audit({ actorId, action: 'CRM_DEALS_SYNCED', entity: 'Closure', after: { ...summary, errors: summary.errors.slice(0, 50) } });
  return summary;
}
