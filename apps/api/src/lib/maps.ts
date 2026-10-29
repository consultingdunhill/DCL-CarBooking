import { encodePolyline, estimateRoute, type LatLng } from '@carbooking/core';
import { env } from '@carbooking/server';

export interface RoutePreview {
  distanceKm: number;
  durationMin: number;
  polyline: string;
  legs: { distanceKm: number; durationMin: number }[];
  source: 'google' | 'estimate';
}

// Routes rarely change; cache them to keep Google Maps costs down.
const cache = new Map<string, { at: number; value: RoutePreview }>();
const TTL = 60 * 60_000;
const keyOf = (pts: LatLng[]) => pts.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');

/**
 * Multi-stop route with distance and duration. Uses the Google Routes API
 * when a server key is configured, otherwise a straight-line estimate.
 */
export async function previewRoute(waypoints: LatLng[]): Promise<RoutePreview> {
  const key = keyOf(waypoints);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  let value: RoutePreview | null = null;
  if (env.GOOGLE_MAPS_SERVER_KEY && waypoints.length >= 2) value = await googleRoute(waypoints).catch((err) => {
    console.error('[routes]', (err as Error).message);
    return null;
  });
  if (!value) {
    const est = estimateRoute(waypoints);
    value = { ...est, polyline: encodePolyline(waypoints), source: 'estimate' };
  }
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}

const wp = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
const seconds = (d: string | undefined) => (d ? Number(d.replace('s', '')) : 0);

async function googleRoute(waypoints: LatLng[]): Promise<RoutePreview> {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env.GOOGLE_MAPS_SERVER_KEY!,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration',
    },
    body: JSON.stringify({
      origin: wp(waypoints[0]!),
      destination: wp(waypoints[waypoints.length - 1]!),
      intermediates: waypoints.slice(1, -1).map(wp),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      polylineEncoding: 'ENCODED_POLYLINE',
    }),
  });
  if (!res.ok) throw new Error(`Routes API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    routes?: { distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string }; legs?: { distanceMeters?: number; duration?: string }[] }[];
  };
  const r = body.routes?.[0];
  if (!r) throw new Error('Routes API returned no route');
  return {
    distanceKm: (r.distanceMeters ?? 0) / 1000,
    durationMin: Math.round(seconds(r.duration) / 60),
    polyline: r.polyline?.encodedPolyline ?? encodePolyline(waypoints),
    legs: (r.legs ?? []).map((l) => ({ distanceKm: (l.distanceMeters ?? 0) / 1000, durationMin: Math.round(seconds(l.duration) / 60) })),
    source: 'google',
  };
}
