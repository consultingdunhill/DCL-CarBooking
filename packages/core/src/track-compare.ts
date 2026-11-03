import { cleanFixes, distanceToPathM, haversineM, polylineLengthKm, type Fix, type LatLng, type PathOptions } from './geo';

/** A place where the car sat still that wasn't a planned stop or the office. */
export interface UnexpectedStop {
  lat: number;
  lng: number;
  startedAt: Date;
  endedAt: Date;
  minutes: number;
  /** How far this dwell was from the planned route, in metres. */
  deviationM: number;
}

export interface TrackComparison {
  /** Usable fixes compared (after cleaning). */
  fixCount: number;
  /** Driven distance along the actual track, km. */
  actualKm: number;
  /** Length of the planned route, km (null if no planned route). */
  plannedKm: number | null;
  /** actualKm − plannedKm: how much further than planned (null if no planned route). */
  extraKm: number | null;
  /** Farthest any fix strayed from the planned route, metres. */
  maxDeviationM: number;
  /** Mean distance of fixes from the planned route, metres. */
  avgDeviationM: number;
  /** Share of fixes within the corridor of the planned route, 0–100. */
  onRoutePct: number;
  /** Count of contiguous off-route runs (a sustained detour). */
  offRouteExcursions: number;
  /** Dwells away from any planned stop or the office. */
  unexpectedStops: UnexpectedStop[];
}

export interface CompareOptions extends PathOptions {
  /** Within this of the planned route counts as "on route" (metres, default 150). */
  corridorM?: number;
  /** A dwell this long counts as a stop (minutes, default 5). */
  dwellMin?: number;
  /** Fixes staying within this radius are "not moving" (metres, default 60). */
  stopRadiusM?: number;
  /** A dwell this close to a planned stop/office is expected, not flagged (metres, default 120). */
  nearPlaceM?: number;
  /** Ignore off-route blips shorter than this many fixes (default 2). */
  minExcursionFixes?: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Compare a car's actual GPS track against the trip's planned route: how closely
 * it followed the route, how much further it drove, and where it stopped that it
 * wasn't supposed to. `expectedPlaces` are the planned stops plus the office —
 * dwells near those are expected and not flagged.
 */
export function compareTrack(rawFixes: Fix[], plannedPath: LatLng[], expectedPlaces: LatLng[], opts: CompareOptions = {}): TrackComparison {
  const corridorM = opts.corridorM ?? 150;
  const dwellMin = opts.dwellMin ?? 5;
  const stopRadiusM = opts.stopRadiusM ?? 60;
  const nearPlaceM = opts.nearPlaceM ?? 120;
  const minExcursion = opts.minExcursionFixes ?? 2;

  const fixes = cleanFixes(rawFixes, opts);
  const actualKm = polylineLengthKm(fixes);
  const plannedKm = plannedPath.length >= 2 ? polylineLengthKm(plannedPath) : null;

  const deviations = plannedPath.length >= 2 ? fixes.map((f) => distanceToPathM(f, plannedPath)) : [];
  const onRoute = deviations.filter((d) => d <= corridorM).length;

  let offRouteExcursions = 0;
  let run = 0;
  for (const d of deviations) {
    if (d > corridorM) {
      run += 1;
      if (run === minExcursion) offRouteExcursions += 1;
    } else {
      run = 0;
    }
  }

  // Anchor-based dwell detection: a run of fixes staying within stopRadiusM of
  // the first fix of the run, lasting at least dwellMin.
  const unexpectedStops: UnexpectedStop[] = [];
  let i = 0;
  while (i < fixes.length) {
    const anchor = fixes[i]!;
    let j = i + 1;
    while (j < fixes.length && haversineM(anchor, fixes[j]!) <= stopRadiusM) j += 1;
    const last = fixes[j - 1]!;
    const minutes = (last.recordedAt.getTime() - anchor.recordedAt.getTime()) / 60_000;
    if (j - i >= 2 && minutes >= dwellMin) {
      const cluster = fixes.slice(i, j);
      const lat = mean(cluster.map((f) => f.lat));
      const lng = mean(cluster.map((f) => f.lng));
      const expected = expectedPlaces.some((pl) => haversineM({ lat, lng }, pl) <= nearPlaceM);
      if (!expected) {
        unexpectedStops.push({
          lat,
          lng,
          startedAt: anchor.recordedAt,
          endedAt: last.recordedAt,
          minutes,
          deviationM: plannedPath.length >= 2 ? distanceToPathM({ lat, lng }, plannedPath) : 0,
        });
      }
      i = j;
    } else {
      i += 1;
    }
  }

  return {
    fixCount: fixes.length,
    actualKm,
    plannedKm,
    extraKm: plannedKm == null ? null : actualKm - plannedKm,
    maxDeviationM: deviations.length ? Math.max(...deviations) : 0,
    avgDeviationM: mean(deviations),
    onRoutePct: fixes.length && deviations.length ? (onRoute / fixes.length) * 100 : 0,
    offRouteExcursions,
    unexpectedStops,
  };
}
