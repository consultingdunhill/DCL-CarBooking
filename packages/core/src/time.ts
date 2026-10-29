import type { WorkingHours } from './settings';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string) {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date: Date, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday!] ?? 0,
  };
}

/** Offset of `tz` from UTC at `date`, in minutes (EAT → +180). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / MINUTE);
}

/** Convert a wall-clock date and time in `tz` to a UTC instant. */
export function zonedTimeToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const [hh, mm] = timeStr.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffsetMinutes(new Date(guess), tz) * MINUTE;
  // Re-check once in case the guess and the answer straddle a DST change.
  const second = guess - tzOffsetMinutes(new Date(first), tz) * MINUTE;
  return new Date(second);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' for the wall-clock date of `date` in `tz`. */
export function zonedDateKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 'HH:MM' wall-clock time of `date` in `tz`. */
export function zonedTimeKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** 'YYYY-MM' month bucket of `date` in `tz`. */
export function monthKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}`;
}

/** UTC instant at 00:00 on the first day of `month` ('YYYY-MM') in `tz`. */
export function monthStart(month: string, tz: string): Date {
  return zonedTimeToUtc(`${month}-01`, '00:00', tz);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

/** Every month key from `from` to `to` inclusive. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function overlapMs(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  return Math.max(0, Math.min(aEnd.getTime(), bEnd.getTime()) - Math.max(aStart.getTime(), bStart.getTime()));
}

/** Half-open interval overlap: [aStart, aEnd) and [bStart, bEnd). */
export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/** Working-hour windows (as UTC instants) that intersect [start, end). */
export function workingWindows(start: Date, end: Date, hours: WorkingHours, tz: string): [Date, Date][] {
  const windows: [Date, Date][] = [];
  if (end <= start) return windows;
  // Start a day early and finish a day late so timezone offsets can't drop a window.
  let day = addDaysToDateKey(zonedDateKey(start, tz), -1);
  const lastDay = addDaysToDateKey(zonedDateKey(end, tz), 1);
  while (day <= lastDay) {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    for (const [from, to] of hours[weekday] ?? []) {
      const ws = zonedTimeToUtc(day, from, tz);
      const we = zonedTimeToUtc(day, to, tz);
      const s = ws > start ? ws : start;
      const e = we < end ? we : end;
      if (e > s) windows.push([s, e]);
    }
    day = addDaysToDateKey(day, 1);
  }
  return windows;
}

/** Total working minutes in [start, end). */
export function workingMinutesBetween(start: Date, end: Date, hours: WorkingHours, tz: string): number {
  return workingWindows(start, end, hours, tz).reduce((sum, [s, e]) => sum + (e.getTime() - s.getTime()) / MINUTE, 0);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MINUTE;
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / HOUR;
}
