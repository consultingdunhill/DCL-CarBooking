import type { TripEndMethod } from '@carbooking/core';
import type { useFormat } from '@/lib/format';
import type { TripSummary } from '@/lib/types';

export type Fmt = ReturnType<typeof useFormat>;

/** "14:02" today, otherwise "Tue 27 Oct 2026, 14:02". */
export function clock(fmt: Fmt, v: string | Date, now: number = Date.now()) {
  return fmt.dateKey(v) === fmt.dateKey(new Date(now)) ? fmt.time(v) : fmt.dateTime(v);
}

/**
 * What the admin sees for a running trip, in the plan's wording (§4.4):
 * Live → "Last seen 2 min ago"; Offline → "Offline since 14:02 (last seen near X)";
 * Location off → "Location turned OFF at 14:02"; Tracking lost → "Tracking lost, last seen 14:02 at X, battery 3%".
 */
export function trackingText(t: TripSummary, fmt: Fmt, now: number = Date.now()): { text: string; detail?: string } {
  const since = t.trackingStatusSince ?? t.lastSeenAt;
  const at = (v: string | null | undefined) => (v ? clock(fmt, v, now) : 'an unknown time');
  switch (t.trackingStatus) {
    case 'LIVE':
      return t.lastSeenAt ? { text: `Last seen ${fmt.relative(t.lastSeenAt)}` } : { text: 'Live, waiting for the first location' };
    case 'OFFLINE':
      return { text: `Offline since ${at(since)}${t.lastAddress ? ` (last seen near ${t.lastAddress})` : ''}` };
    case 'LOCATION_OFF':
      return {
        text: `Location turned OFF at ${at(since)}`,
        detail: t.lastAddress
          ? `Last location: ${t.lastAddress}${t.lastSeenAt ? `, ${at(t.lastSeenAt)}` : ''}`
          : t.lastLat != null
            ? `Last location shown on the map${t.lastSeenAt ? ` (${at(t.lastSeenAt)})` : ''}`
            : undefined,
      };
    case 'TRACKING_LOST':
      return {
        text: `Tracking lost, last seen ${at(t.lastSeenAt ?? since)}${t.lastAddress ? ` at ${t.lastAddress}` : ''}${t.lastBattery != null ? `, battery ${t.lastBattery}%` : ''}`,
      };
    case 'STOPPED':
      return { text: `Tracking stopped${since ? ` at ${at(since)}` : ''}` };
    case 'NOT_STARTED':
    default:
      return { text: 'Tracking has not started' };
  }
}

export const END_METHOD_LABELS: Record<TripEndMethod, string> = {
  MANUAL: 'Ended by trip owner',
  GEOFENCE: 'Back at office',
  ADMIN: 'Closed by admin',
};

/** When the trip is due back: the (possibly extended) ETA, else the booked return. */
export function dueBack(trip: { etaAt: string | null } | null | undefined, expectedReturnAt: string) {
  return trip?.etaAt ?? expectedReturnAt;
}

export function googleMapsLink(lat: number, lng: number) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
