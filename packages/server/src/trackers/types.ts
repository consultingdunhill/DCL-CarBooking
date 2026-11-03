/**
 * Hardware GPS trackers (the boxes fitted to the cars), as opposed to the trip
 * owner's phone. A provider turns one vendor's API into a normalized stream of
 * fixes we can feed into the trip tracking pipeline.
 */

/** One position report from a hardware tracker, already normalized. */
export interface TrackerPosition {
  /** Vendor device id this fix belongs to (matches Car.trackerDeviceId). */
  deviceId: string;
  /** Device time of the fix. */
  recordedAt: Date;
  lat: number;
  lng: number;
  /** Ground speed, m/s. */
  speed?: number | null;
  /** Heading, degrees from north. */
  heading?: number | null;
  altitude?: number | null;
  /** Ignition / ACC state, when the tracker reports it. */
  ignition?: boolean | null;
  /** Device battery 0–100, when the tracker reports it. */
  battery?: number | null;
}

export interface TrackerProvider {
  readonly name: string;
  /**
   * Latest fixes for the given devices with a device time after `since`.
   * Over-fetching is fine: the ingest layer dedupes and clamps to the trip window.
   */
  fetchPositions(deviceIds: string[], since: Date): Promise<TrackerPosition[]>;
}

export class TrackerError extends Error {}
