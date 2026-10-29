import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, resolveSettings } from './settings';
import { addMonths, monthKey, monthRange, workingMinutesBetween, zonedDateKey, zonedTimeToUtc } from './time';

const TZ = 'Africa/Nairobi';

describe('time', () => {
  it('converts East Africa Time to UTC', () => {
    expect(zonedTimeToUtc('2026-11-02', '10:00', TZ).toISOString()).toBe('2026-11-02T07:00:00.000Z');
    expect(zonedTimeToUtc('2026-11-02', '01:30', TZ).toISOString()).toBe('2026-11-01T22:30:00.000Z');
  });

  it('buckets by local month and day', () => {
    const lateNightUtc = new Date('2026-10-31T22:30:00Z'); // 01:30 on 1 Nov in Nairobi
    expect(monthKey(lateNightUtc, TZ)).toBe('2026-11');
    expect(zonedDateKey(lateNightUtc, TZ)).toBe('2026-11-01');
  });

  it('walks months', () => {
    expect(addMonths('2026-01', -2)).toBe('2025-11');
    expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });

  it('counts working hours: Mon–Fri 08–18 and Sat 09–13', () => {
    // Mon 2 Nov 00:00 → Mon 9 Nov 00:00 (EAT): 5 × 10 h + 4 h = 54 h.
    const from = zonedTimeToUtc('2026-11-02', '00:00', TZ);
    const to = zonedTimeToUtc('2026-11-09', '00:00', TZ);
    expect(workingMinutesBetween(from, to, DEFAULT_SETTINGS.workingHours, TZ)).toBe(54 * 60);
  });

  it('counts only the working part of a booking', () => {
    const from = zonedTimeToUtc('2026-11-02', '16:00', TZ);
    const to = zonedTimeToUtc('2026-11-02', '20:00', TZ);
    expect(workingMinutesBetween(from, to, DEFAULT_SETTINGS.workingHours, TZ)).toBe(120);
  });
});

describe('settings', () => {
  it('merges stored values over defaults and drops invalid ones', () => {
    const s = resolveSettings([
      { key: 'currency', value: 'USD' },
      { key: 'overdueGraceMin', value: 'not a number' },
      { key: 'unknown', value: 1 },
    ]);
    expect(s.currency).toBe('USD');
    expect(s.overdueGraceMin).toBe(15);
  });
});
