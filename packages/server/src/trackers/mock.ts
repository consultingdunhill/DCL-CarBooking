import type { TrackerPosition, TrackerProvider } from './types';

/** Stable 32-bit hash so each device gets its own repeatable route. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const STEP_MS = 20_000; // one synthetic fix every 20s
const SPEED_MS = 9; // ~32 km/h
const MAX_BACKFILL_MS = 5 * 60_000; // never invent more than 5 min of history per poll

/**
 * Synthetic trackers for local development. Each device drives a smooth, looping
 * route anchored near Nairobi, advancing with wall-clock time so the live map
 * actually moves. No network, no credentials — set TRACKER_PROVIDER=mock.
 */
export class MockTrackerProvider implements TrackerProvider {
  readonly name = 'mock';

  async fetchPositions(deviceIds: string[], since: Date): Promise<TrackerPosition[]> {
    const now = Date.now();
    const out: TrackerPosition[] = [];
    for (const deviceId of deviceIds) {
      const seed = hash(deviceId);
      const baseLat = -1.2921 + ((seed % 1000) / 1000 - 0.5) * 0.08;
      const baseLng = 36.8219 + (((seed >> 10) % 1000) / 1000 - 0.5) * 0.08;
      const baseBearing = (seed % 360) * (Math.PI / 180);

      const from = Math.max(since.getTime() + STEP_MS, now - MAX_BACKFILL_MS);
      for (let t = Math.ceil(from / STEP_MS) * STEP_MS; t <= now; t += STEP_MS) {
        const tSec = t / 1000;
        // Gently curving heading so the path isn't a straight line.
        const bearing = baseBearing + Math.sin(tSec / 180) * 0.6;
        // Drive out and loop back every ~10 minutes.
        const dist = SPEED_MS * (tSec % 600);
        const jitter = ((hash(`${deviceId}:${t}`) % 100) / 100 - 0.5) * 6; // ±3 m
        const d = dist + jitter;
        const dLat = (d * Math.cos(bearing)) / 111_320;
        const dLng = (d * Math.sin(bearing)) / (111_320 * Math.cos((baseLat * Math.PI) / 180));
        out.push({
          deviceId,
          recordedAt: new Date(t),
          lat: baseLat + dLat,
          lng: baseLng + dLng,
          speed: SPEED_MS,
          heading: ((bearing * 180) / Math.PI + 360) % 360,
          ignition: true,
          battery: null,
        });
      }
    }
    return out;
  }
}
