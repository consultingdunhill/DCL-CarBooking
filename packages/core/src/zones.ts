import { cleanFixes, haversineM, isWithinZone, type Fix, type LatLng } from './geo';
import { MINUTE } from './time';

export interface Visit {
  arrivedAt: Date;
  /** When the dwell requirement was met (arrival is "confirmed"). */
  confirmedAt: Date;
  /** Last fix inside the zone before leaving; null while still there. */
  departedAt: Date | null;
}

interface ZoneOptions {
  radiusM: number;
  dwellMin: number;
  maxAccuracyM?: number;
}

/**
 * Runs of consecutive fixes inside a zone that last at least `dwellMin`.
 * A run that reaches the end of the data is still open (no departure yet).
 */
export function findVisits(fixes: Fix[], center: LatLng, opts: ZoneOptions): Visit[] {
  const clean = cleanFixes(fixes, { maxAccuracyM: opts.maxAccuracyM });
  const visits: Visit[] = [];
  let runStart: Fix | null = null;
  let runLast: Fix | null = null;

  const closeRun = (left: boolean) => {
    if (!runStart || !runLast) return;
    const dwellMs = runLast.recordedAt.getTime() - runStart.recordedAt.getTime();
    if (dwellMs >= opts.dwellMin * MINUTE) {
      visits.push({
        arrivedAt: runStart.recordedAt,
        confirmedAt: new Date(runStart.recordedAt.getTime() + opts.dwellMin * MINUTE),
        departedAt: left ? runLast.recordedAt : null,
      });
    }
  };

  for (const fix of clean) {
    if (isWithinZone(fix, center, opts.radiusM)) {
      if (!runStart) runStart = fix;
      runLast = fix;
    } else if (runStart) {
      closeRun(true);
      runStart = runLast = null;
    }
  }
  closeRun(false);
  return visits;
}

export interface StopTarget extends LatLng {
  id: string;
}

/**
 * Arrival and departure at each stop from the GPS track: the phone within
 * `radiusM` of the stop and there for `dwellMin`+. Uses the first qualifying
 * visit per stop.
 */
export function detectStopVisits(fixes: Fix[], stops: StopTarget[], opts: ZoneOptions): Map<string, Visit> {
  const result = new Map<string, Visit>();
  for (const stop of stops) {
    const [first] = findVisits(fixes, stop, opts);
    if (first) result.set(stop.id, first);
  }
  return result;
}

export interface OfficeZone extends LatLng {
  arrivalRadiusM: number;
  wakeupRadiusM: number;
}

/**
 * Detect the car arriving back at the office: after first leaving the wake-up
 * radius, a run of fixes within the arrival zone lasting `dwellMin`. Driving
 * past without stopping doesn't count.
 */
export function detectOfficeArrival(
  fixes: Fix[],
  office: OfficeZone,
  opts: { dwellMin: number; maxAccuracyM?: number },
): Visit | null {
  const clean = cleanFixes(fixes, { maxAccuracyM: opts.maxAccuracyM });
  const leftIdx = clean.findIndex((f) => haversineM(f, office) > office.wakeupRadiusM);
  if (leftIdx < 0) return null;
  const [visit] = findVisits(clean.slice(leftIdx), office, {
    radiusM: office.arrivalRadiusM,
    dwellMin: opts.dwellMin,
    maxAccuracyM: opts.maxAccuracyM,
  });
  return visit ?? null;
}
