import { describe, expect, it } from 'vitest';
import { deriveTrackingStatus, odometerVariancePct, statusChangeEvent, validateEndOdometer, validateStartOdometer } from './trip';

const thresholds = { offlineThresholdMin: 5, trackingLostThresholdMin: 30, deadBatteryPct: 5 };
const at = (min: number) => new Date(Date.UTC(2026, 10, 2, 11, 0) + min * 60_000);

describe('odometer', () => {
  it('blocks a start reading below the last end reading', () => {
    expect(() => validateStartOdometer(45_000, 45_100)).toThrow(/lower than the car's last recorded reading/);
  });

  it('records the gap as unlogged km', () => {
    expect(validateStartOdometer(45_130, 45_100)).toEqual({ unloggedKm: 30 });
    expect(validateStartOdometer(45_100, 45_100)).toEqual({ unloggedKm: 0 });
    expect(validateStartOdometer(10, null)).toEqual({ unloggedKm: 0 });
  });

  it('requires the end reading to be at least the start reading', () => {
    expect(() => validateEndOdometer(99, 100)).toThrow(/lower than the start/);
    expect(validateEndOdometer(142, 100)).toEqual({ tripKm: 42 });
    expect(() => validateEndOdometer(100 + 5000, 100)).toThrow(/Check the reading/);
  });

  it('computes odometer vs GPS variance', () => {
    expect(odometerVariancePct(100, 90)).toBeCloseTo(10);
    expect(odometerVariancePct(null, 90)).toBeNull();
  });
});

describe('deriveTrackingStatus', () => {
  const base = { startedAt: at(0), lastContactAt: at(0), locationOffSince: null, lastBattery: 80 };

  it('is live while the device is in contact', () => {
    expect(deriveTrackingStatus(base, at(4), thresholds).status).toBe('LIVE');
  });

  it('shows location off as soon as the device reports it', () => {
    const s = deriveTrackingStatus({ ...base, locationOffSince: at(2), lastContactAt: at(2) }, at(3), thresholds);
    expect(s).toEqual({ status: 'LOCATION_OFF', since: at(2) });
  });

  it('goes offline after 5 minutes of silence', () => {
    expect(deriveTrackingStatus(base, at(6), thresholds)).toEqual({ status: 'OFFLINE', since: at(0) });
  });

  it('becomes tracking lost after a long silence', () => {
    expect(deriveTrackingStatus(base, at(31), thresholds).status).toBe('TRACKING_LOST');
  });

  it('becomes tracking lost quickly when the battery was nearly dead', () => {
    const s = deriveTrackingStatus({ ...base, lastBattery: 3 }, at(6), thresholds);
    expect(s).toEqual({ status: 'TRACKING_LOST', since: at(0) });
  });

  it('maps status changes to timeline events', () => {
    expect(statusChangeEvent('LIVE', 'OFFLINE')).toBe('OFFLINE');
    expect(statusChangeEvent('OFFLINE', 'LIVE')).toBe('ONLINE');
    expect(statusChangeEvent('TRACKING_LOST', 'LIVE')).toBe('TRACKING_RESUMED');
    expect(statusChangeEvent('LIVE', 'LIVE')).toBeNull();
  });
});
