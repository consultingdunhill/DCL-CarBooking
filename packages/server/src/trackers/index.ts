import type { DeviceLocation } from '@carbooking/core';
import { env } from '../env';
import { MockTrackerProvider } from './mock';
import { OverseeTrackerProvider } from './oversee';
import type { TrackerPosition, TrackerProvider } from './types';

export * from './types';

/** Whether a hardware tracker provider is configured (anything but `none`). */
export const trackerEnabled = () => env.TRACKER_PROVIDER !== 'none';

let provider: TrackerProvider | null = null;

/** The configured provider, created once. Call only when trackerEnabled(). */
export function getTrackerProvider(): TrackerProvider {
  if (provider) return provider;
  switch (env.TRACKER_PROVIDER) {
    case 'mock':
      return (provider = new MockTrackerProvider());
    case 'oversee':
      return (provider = new OverseeTrackerProvider());
    default:
      throw new Error(`No tracker provider for TRACKER_PROVIDER=${env.TRACKER_PROVIDER}`);
  }
}

/**
 * A tracker fix in the shape ingestLocations() expects (the phone plugin's
 * DeviceLocation). The uuid is deterministic (device + time) so re-polling the
 * same fix is skipped as a duplicate. battery is left on the 0–100 scale, which
 * ingest's batteryPct() passes through unchanged.
 */
export function trackerToDeviceLocation(p: TrackerPosition): DeviceLocation {
  return {
    uuid: `trk:${p.deviceId}:${p.recordedAt.getTime()}`,
    timestamp: p.recordedAt.toISOString(),
    is_moving: p.ignition ?? undefined,
    coords: {
      latitude: p.lat,
      longitude: p.lng,
      speed: p.speed ?? undefined,
      heading: p.heading ?? undefined,
      altitude: p.altitude ?? undefined,
    },
    battery: p.battery != null ? { level: p.battery } : undefined,
  };
}
