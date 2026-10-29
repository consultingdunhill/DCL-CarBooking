import { haversineM } from '@carbooking/core';
import { prisma } from '@carbooking/db';
import { env } from './env';

const cache = new Map<string, { at: number; value: string }>();
const TTL = 6 * 60 * 60_000;

/**
 * A short human description of a position for "last seen near X": Google's
 * reverse geocode when configured, otherwise the nearest known property or the
 * office, otherwise the coordinates.
 */
export async function describeLocation(lat: number, lng: number): Promise<string> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  let value: string | null = null;
  if (env.GOOGLE_MAPS_SERVER_KEY) {
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=street_address|route|sublocality|neighborhood&key=${env.GOOGLE_MAPS_SERVER_KEY}`,
      );
      const body = (await res.json()) as { results?: { formatted_address: string }[] };
      value = body.results?.[0]?.formatted_address?.replace(/, Kenya$/, '') ?? null;
    } catch (err) {
      console.error('[geocode]', (err as Error).message);
    }
  }
  if (!value) value = await nearestKnownPlace(lat, lng);
  if (!value) value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function nearestKnownPlace(lat: number, lng: number): Promise<string | null> {
  const offices = await prisma.office.findMany();
  for (const o of offices) {
    const m = haversineM({ lat, lng }, o);
    if (m < 300) return m < 50 ? o.name : `${Math.round(m)} m from ${o.name}`;
  }
  const rows = await prisma.$queryRaw<{ ref: string; address: string; meters: number }[]>`
    SELECT ref, address, ST_Distance(geog, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) AS meters
    FROM "Property"
    WHERE geog IS NOT NULL AND ST_DWithin(geog, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, 1000)
    ORDER BY meters
    LIMIT 1`;
  const p = rows[0];
  if (!p) return null;
  return p.meters < 60 ? `${p.ref} · ${p.address}` : `${Math.round(p.meters)} m from ${p.ref} · ${p.address}`;
}

/** Properties near a point (for "is this one of ours?" when dropping a pin). */
export async function nearbyProperties(lat: number, lng: number, radiusM = 250) {
  return prisma.$queryRaw<{ id: string; ref: string; address: string; meters: number }[]>`
    SELECT id, ref, address, ST_Distance(geog, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) AS meters
    FROM "Property"
    WHERE geog IS NOT NULL
      AND ST_DWithin(geog, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusM})
    ORDER BY meters
    LIMIT 5`;
}
