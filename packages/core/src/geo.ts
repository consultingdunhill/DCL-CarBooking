export interface LatLng {
  lat: number;
  lng: number;
}

export interface Fix extends LatLng {
  recordedAt: Date;
  accuracy?: number | null;
  speed?: number | null;
  isMoving?: boolean | null;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface PathOptions {
  /** Ignore fixes less accurate than this (metres). */
  maxAccuracyM?: number;
  /** Ignore jumps implying a speed above this (km/h); they are GPS glitches. */
  maxSpeedKmh?: number;
}

/** Usable fixes, in time order, with inaccurate fixes and impossible jumps removed. */
export function cleanFixes<T extends Fix>(points: T[], opts: PathOptions = {}): T[] {
  const maxAcc = opts.maxAccuracyM ?? 75;
  const maxSpeed = opts.maxSpeedKmh ?? 200;
  const sorted = points
    .filter((p) => p.accuracy == null || p.accuracy <= maxAcc)
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  const out: T[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (prev) {
      const dtH = (p.recordedAt.getTime() - prev.recordedAt.getTime()) / 3_600_000;
      const km = haversineM(prev, p) / 1000;
      if (dtH > 0 && km / dtH > maxSpeed) continue;
    }
    out.push(p);
  }
  return out;
}

/** Driven distance along a GPS track, in km. */
export function pathDistanceKm(points: Fix[], opts: PathOptions = {}): number {
  const clean = cleanFixes(points, opts);
  let m = 0;
  for (let i = 1; i < clean.length; i++) m += haversineM(clean[i - 1]!, clean[i]!);
  return m / 1000;
}

/**
 * Whether a fix is inside a circular zone, allowing for the fix's reported
 * accuracy. The allowance is capped at the zone radius so a poor fix can't
 * stretch a 20 m zone to 100 m.
 */
export function isWithinZone(fix: LatLng & { accuracy?: number | null }, center: LatLng, radiusM: number): boolean {
  const allowance = Math.min(fix.accuracy ?? 0, radiusM);
  return haversineM(fix, center) <= radiusM + allowance;
}

export function boundsOf(points: LatLng[]): { south: number; west: number; north: number; east: number } | null {
  if (points.length === 0) return null;
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const p of points) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
  }
  return { south, west, north, east };
}

// Google encoded polyline algorithm (precision 5), used by the Routes API.
export function encodePolyline(points: LatLng[]): string {
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    out += enc(lat - prevLat) + enc(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/** Rough road distance and duration when no routing service is configured. */
export function estimateRoute(waypoints: LatLng[], opts: { roadFactor?: number; avgSpeedKmh?: number } = {}) {
  const roadFactor = opts.roadFactor ?? 1.35;
  const speed = opts.avgSpeedKmh ?? 25; // Nairobi traffic
  let m = 0;
  for (let i = 1; i < waypoints.length; i++) m += haversineM(waypoints[i - 1]!, waypoints[i]!);
  const distanceKm = (m / 1000) * roadFactor;
  return {
    distanceKm,
    durationMin: Math.round((distanceKm / speed) * 60),
    legs: waypoints.slice(1).map((w, i) => {
      const km = (haversineM(waypoints[i]!, w) / 1000) * roadFactor;
      return { distanceKm: km, durationMin: Math.round((km / speed) * 60) };
    }),
  };
}
