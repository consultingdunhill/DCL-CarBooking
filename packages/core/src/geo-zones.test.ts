import { describe, expect, it } from 'vitest';
import { decodePolyline, encodePolyline, haversineM, isWithinZone, pathDistanceKm, type Fix } from './geo';
import { detectOfficeArrival, detectStopVisits, findVisits } from './zones';

const office = { lat: -1.2921, lng: 36.8219 };
// ~111 m per 0.001° of latitude.
const north = (m: number) => ({ lat: office.lat + m / 111_195, lng: office.lng });
const t0 = Date.UTC(2026, 10, 2, 7, 0);
const fix = (min: number, m: number, accuracy = 8): Fix => ({ ...north(m), recordedAt: new Date(t0 + min * 60_000), accuracy });

describe('geo', () => {
  it('measures distance', () => {
    expect(haversineM(office, north(1000))).toBeCloseTo(1000, -1);
  });

  it('sums a track and drops impossible jumps and poor fixes', () => {
    const track = [fix(0, 0), fix(1, 500), fix(1.01, 50_000), fix(2, 1000), fix(3, 1500, 500)];
    expect(pathDistanceKm(track, { maxAccuracyM: 75 })).toBeCloseTo(1, 1);
  });

  it('allows for fix accuracy, capped at the zone radius', () => {
    expect(isWithinZone({ ...north(30), accuracy: 15 }, office, 20)).toBe(true);
    expect(isWithinZone({ ...north(45), accuracy: 60 }, office, 20)).toBe(false);
  });

  it('round-trips encoded polylines', () => {
    const pts = [office, north(1000), { lat: -1.3, lng: 36.79 }];
    const back = decodePolyline(encodePolyline(pts));
    back.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(pts[i]!.lat, 5);
      expect(p.lng).toBeCloseTo(pts[i]!.lng, 5);
    });
  });
});

describe('zones', () => {
  const opts = { radiusM: 50, dwellMin: 2 };

  it('records arrival and departure at a stop after a 2-minute dwell', () => {
    const stop = { id: 's1', ...north(3000) };
    const track = [fix(0, 0), fix(5, 2000), fix(8, 2990), fix(9, 3000), fix(14, 3010), fix(20, 3005), fix(21, 3400)];
    const visit = detectStopVisits(track, [stop], opts).get('s1');
    expect(visit?.arrivedAt).toEqual(new Date(t0 + 8 * 60_000));
    expect(visit?.departedAt).toEqual(new Date(t0 + 20 * 60_000));
  });

  it('ignores passing a stop without stopping', () => {
    const track = [fix(0, 2900), fix(0.5, 3000), fix(1, 3100)];
    expect(findVisits(track, north(3000), opts)).toEqual([]);
  });

  it('keeps a visit open while still at the stop', () => {
    const track = [fix(0, 3000), fix(3, 3001)];
    expect(findVisits(track, north(3000), opts)[0]?.departedAt).toBeNull();
  });

  const zone = { ...office, arrivalRadiusM: 20, wakeupRadiusM: 150 };

  it('does not count the time at the office before leaving', () => {
    const track = [fix(0, 0), fix(3, 5), fix(4, 400)];
    expect(detectOfficeArrival(track, zone, { dwellMin: 2 })).toBeNull();
  });

  it('detects arrival back at the office after stopping within 20 m', () => {
    const track = [fix(0, 0), fix(5, 2000), fix(30, 300), fix(31, 10), fix(33.5, 8)];
    const v = detectOfficeArrival(track, zone, { dwellMin: 2 });
    expect(v?.arrivedAt).toEqual(new Date(t0 + 31 * 60_000));
  });

  it('does not prompt when driving past the office', () => {
    const track = [fix(0, 0), fix(5, 2000), fix(30, 100), fix(30.3, 5), fix(30.6, -100), fix(31, -400)];
    expect(detectOfficeArrival(track, zone, { dwellMin: 2 })).toBeNull();
  });
});
