import { zonedParts } from './time';

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmtTime(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function fmtDate(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${DAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

export function fmtDateTime(d: Date, tz: string): string {
  return `${fmtDate(d, tz)}, ${fmtTime(d, tz)}`;
}

/** "10:00–13:00", with the date when the window spans days. */
export function fmtWindow(start: Date, end: Date, tz: string): string {
  const s = zonedParts(start, tz);
  const e = zonedParts(end, tz);
  const sameDay = s.year === e.year && s.month === e.month && s.day === e.day;
  return sameDay ? `${fmtTime(start, tz)}–${fmtTime(end, tz)}` : `${fmtDateTime(start, tz)} – ${fmtDateTime(end, tz)}`;
}

/** "Mon 2 Nov 2026, 10:00–13:00". */
export function fmtWhen(start: Date, end: Date, tz: string): string {
  const window = fmtWindow(start, end, tz);
  return window.includes(' – ') ? window : `${fmtDate(start, tz)}, ${window}`;
}

export function fmtMoney(amount: number | null | undefined, currency: string): string {
  if (amount == null || !Number.isFinite(amount)) return '–';
  return `${currency} ${amount.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: amount < 100 ? 2 : 0 })}`;
}

export function fmtKm(km: number | null | undefined): string {
  if (km == null || !Number.isFinite(km)) return '–';
  return `${km.toLocaleString('en-KE', { maximumFractionDigits: km < 10 ? 1 : 0 })} km`;
}

export function fmtDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** "Jane M." for showing who holds a slot. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? name;
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`;
}

/**
 * Normalise a Kenyan phone number to E.164 (+2547XXXXXXXX). Numbers already in
 * international form are kept; anything unrecognised is returned trimmed.
 */
export function toE164(phone: string, defaultCountryCode = '254'): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith(defaultCountryCode)) return `+${digits}`;
  if (digits.startsWith('0')) return `+${defaultCountryCode}${digits.slice(1)}`;
  if (digits.length === 9) return `+${defaultCountryCode}${digits}`;
  return phone.trim();
}

export function whatsappLink(phone: string, text?: string): string {
  const n = toE164(phone).replace(/^\+/, '');
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function telLink(phone: string): string {
  return `tel:${toE164(phone)}`;
}

/** "Driver is out with Jane M., 10:00–13:00, going to Westlands". */
export function describeBusySlot(
  slot: { ownerName: string; startAt: Date; expectedReturnAt: Date; destinations: string[] },
  tz: string,
): string {
  const where = slot.destinations.length ? `, going to ${slot.destinations.slice(0, 3).join(', ')}` : '';
  return `Driver is out with ${shortName(slot.ownerName)}, ${fmtWindow(slot.startAt, slot.expectedReturnAt, tz)}${where}`;
}
