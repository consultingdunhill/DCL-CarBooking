import { describe, expect, it } from 'vitest';
import { type Fix, type LatLng } from './geo';
import { compareTrack } from './track-compare';

const T0 = Date.UTC(2026, 0, 1, 8, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000);

// A ~1.11 km planned leg heading due north along lng 0.
const planned: LatLng[] = [
  { lat: 0, lng: 0 },
  { lat: 0.01, lng: 0 },
];

describe('compareTrack', () => {
  it('reports a clean on-route run', () => {
    const fixes: Fix[] = [0, 0.002, 0.004, 0.006, 0.008, 0.01].map((lat, i) => ({ lat, lng: 0, recordedAt: at(i) }));
    const cmp = compareTrack(fixes, planned, []);
    expect(cmp.fixCount).toBe(6);
    expect(cmp.onRoutePct).toBe(100);
    expect(cmp.maxDeviationM).toBeLessThan(5);
    expect(cmp.offRouteExcursions).toBe(0);
    expect(cmp.unexpectedStops).toHaveLength(0);
    expect(cmp.plannedKm).toBeCloseTo(1.11, 1);
  });

  it('flags a sustained detour off the route', () => {
    const fixes: Fix[] = [
      { lat: 0, lng: 0, recordedAt: at(0) },
      { lat: 0.002, lng: 0, recordedAt: at(1) },
      { lat: 0.004, lng: 0.003, recordedAt: at(2) }, // ~334 m east of the route
      { lat: 0.006, lng: 0.003, recordedAt: at(3) }, // still off route
      { lat: 0.008, lng: 0, recordedAt: at(4) },
      { lat: 0.01, lng: 0, recordedAt: at(5) },
    ];
    const cmp = compareTrack(fixes, planned, []);
    expect(cmp.maxDeviationM).toBeGreaterThan(150);
    expect(cmp.offRouteExcursions).toBe(1);
    expect(cmp.onRoutePct).toBeCloseTo((4 / 6) * 100, 5);
  });

  it('detects an unexpected stop away from planned places', () => {
    const fixes: Fix[] = [];
    [0, 0.003, 0.006, 0.009].forEach((lat, i) => fixes.push({ lat, lng: 0, recordedAt: at(i) }));
    for (let k = 0; k <= 6; k++) fixes.push({ lat: 0.02, lng: 0.02, recordedAt: at(4 + k) }); // sit still 6 min, far off route
    const cmp = compareTrack(fixes, planned, [{ lat: 0.01, lng: 0 }]);
    expect(cmp.unexpectedStops).toHaveLength(1);
    expect(cmp.unexpectedStops[0]!.minutes).toBeGreaterThanOrEqual(5);
    expect(cmp.unexpectedStops[0]!.deviationM).toBeGreaterThan(150);
  });

  it('does not flag a dwell at an expected place', () => {
    const fixes: Fix[] = [];
    for (let k = 0; k <= 6; k++) fixes.push({ lat: 0.01, lng: 0, recordedAt: at(k) }); // parked at the route's end...
    const cmp = compareTrack(fixes, planned, [{ lat: 0.01, lng: 0 }]); // ...which is an expected place
    expect(cmp.unexpectedStops).toHaveLength(0);
  });
});
