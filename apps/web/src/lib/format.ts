import {
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtKm,
  fmtMoney,
  fmtTime,
  fmtWhen,
  fmtWindow,
  shortName,
  zonedDateKey,
  zonedTimeKey,
  zonedTimeToUtc,
} from '@carbooking/core';
import { useReference } from './queries';

const DEFAULT_TZ = 'Africa/Nairobi';

const d = (v: string | Date) => (typeof v === 'string' ? new Date(v) : v);

/** Formatting bound to the configured timezone and currency (East Africa Time, KES by default). */
export function useFormat() {
  const ref = useReference().data;
  const tz = ref?.settings.timezone ?? DEFAULT_TZ;
  const currency = ref?.settings.currency ?? 'KES';
  return {
    tz,
    currency,
    time: (v: string | Date) => fmtTime(d(v), tz),
    date: (v: string | Date) => fmtDate(d(v), tz),
    dateTime: (v: string | Date) => fmtDateTime(d(v), tz),
    window: (a: string | Date, b: string | Date) => fmtWindow(d(a), d(b), tz),
    when: (a: string | Date, b: string | Date) => fmtWhen(d(a), d(b), tz),
    money: (n: number | null | undefined) => fmtMoney(n, currency),
    km: fmtKm,
    duration: fmtDuration,
    shortName,
    /** 'YYYY-MM-DD' in the office timezone. */
    dateKey: (v: string | Date) => zonedDateKey(d(v), tz),
    timeKey: (v: string | Date) => zonedTimeKey(d(v), tz),
    /** Wall-clock date + time in the office timezone → ISO string. */
    toIso: (date: string, time: string) => zonedTimeToUtc(date, time, tz).toISOString(),
    relative: (v: string | Date) => relative(d(v)),
  };
}

export function relative(date: Date, now = new Date()): string {
  const s = Math.round((now.getTime() - date.getTime()) / 1000);
  const abs = Math.abs(s);
  const suffix = s >= 0 ? 'ago' : 'from now';
  if (abs < 45) return s >= 0 ? 'just now' : 'in a moment';
  if (abs < 3600) return `${Math.round(abs / 60)} min ${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)} h ${suffix}`;
  return `${Math.round(abs / 86400)} d ${suffix}`;
}
