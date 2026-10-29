import type { TrackingEventType, TrackingStatus } from './enums';
import { DomainError } from './errors';
import { MINUTE } from './time';

// ── Odometer rules ────────────────────────────────────────────────────────────

/**
 * The start reading must be at least the car's last recorded end reading. Any
 * gap is km driven without a logged trip ("unlogged km").
 */
export function validateStartOdometer(reading: number, lastEndReading: number | null): { unloggedKm: number } {
  if (!Number.isInteger(reading) || reading < 0) {
    throw new DomainError('INVALID_ODOMETER', 'Enter the odometer reading in whole km');
  }
  if (lastEndReading != null && reading < lastEndReading) {
    throw new DomainError(
      'ODOMETER_BELOW_LAST',
      `The reading (${reading} km) is lower than the car's last recorded reading (${lastEndReading} km)`,
      422,
      { lastEndReading },
    );
  }
  return { unloggedKm: lastEndReading == null ? 0 : reading - lastEndReading };
}

export const MAX_TRIP_KM = 2000;

export function validateEndOdometer(reading: number, startReading: number): { tripKm: number } {
  if (!Number.isInteger(reading) || reading < 0) {
    throw new DomainError('INVALID_ODOMETER', 'Enter the odometer reading in whole km');
  }
  if (reading < startReading) {
    throw new DomainError(
      'ODOMETER_BELOW_START',
      `The end reading (${reading} km) is lower than the start reading (${startReading} km)`,
      422,
      { startReading },
    );
  }
  if (reading - startReading > MAX_TRIP_KM) {
    throw new DomainError('ODOMETER_IMPLAUSIBLE', `That would be a ${reading - startReading} km trip. Check the reading.`);
  }
  return { tripKm: reading - startReading };
}

/** Percentage difference between odometer km and GPS km, or null when it can't be judged. */
export function odometerVariancePct(odometerKm: number | null, gpsKm: number | null): number | null {
  if (odometerKm == null || gpsKm == null) return null;
  if (odometerKm === 0 && gpsKm === 0) return 0;
  const base = Math.max(odometerKm, 1);
  return (Math.abs(odometerKm - gpsKm) / base) * 100;
}

// ── Tracking status ───────────────────────────────────────────────────────────

export interface TrackingThresholds {
  offlineThresholdMin: number;
  trackingLostThresholdMin: number;
  deadBatteryPct: number;
}

export interface TrackingState {
  /** Server time the device last reached the API (any request). */
  lastContactAt: Date | null;
  /** Set while the device reports location services off or permission downgraded. */
  locationOffSince: Date | null;
  /** Last known battery level, 0–100. */
  lastBattery: number | null;
  startedAt: Date;
}

/**
 * Status shown to the admin for a trip in progress.
 *
 * Priority: tracking lost (long silence, or silence with a nearly dead battery)
 * → location off → offline → live.
 */
export function deriveTrackingStatus(
  state: TrackingState,
  now: Date,
  t: TrackingThresholds,
): { status: TrackingStatus; since: Date } {
  const lastContact = state.lastContactAt ?? state.startedAt;
  const silentMin = (now.getTime() - lastContact.getTime()) / MINUTE;
  const batteryDead = state.lastBattery != null && state.lastBattery <= t.deadBatteryPct;

  if (silentMin > t.trackingLostThresholdMin || (silentMin > t.offlineThresholdMin && batteryDead)) {
    return { status: 'TRACKING_LOST', since: lastContact };
  }
  if (state.locationOffSince) return { status: 'LOCATION_OFF', since: state.locationOffSince };
  if (silentMin > t.offlineThresholdMin) return { status: 'OFFLINE', since: lastContact };
  return { status: 'LIVE', since: lastContact };
}

/** Which tracking event to log when the status changes. */
export function statusChangeEvent(from: TrackingStatus, to: TrackingStatus): TrackingEventType | null {
  if (from === to) return null;
  switch (to) {
    case 'OFFLINE':
      return 'OFFLINE';
    case 'TRACKING_LOST':
      return 'TRACKING_LOST';
    case 'LIVE':
      if (from === 'OFFLINE') return 'ONLINE';
      if (from === 'TRACKING_LOST') return 'TRACKING_RESUMED';
      return null;
    default:
      return null;
  }
}

export const TRACKING_STATUS_LABELS: Record<TrackingStatus, string> = {
  NOT_STARTED: 'Not started',
  LIVE: 'Live',
  OFFLINE: 'Offline',
  LOCATION_OFF: 'Location off',
  TRACKING_LOST: 'Tracking lost',
  STOPPED: 'Stopped',
};
