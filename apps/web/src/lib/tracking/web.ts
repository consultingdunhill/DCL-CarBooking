/**
 * Tracking in the browser (the installed web app, VITE_ALLOW_WEB_TRIPS).
 * Browsers only run it while Fleet is on screen: locking the phone or
 * switching to another app pauses it until Fleet is opened again. So it keeps
 * the screen awake while the trip page is open, sends the first fix at once,
 * and catches up as soon as the app is back in front. Background tracking
 * needs the native app.
 */
import { haversineM } from '@carbooking/core';
import { isIOS } from '../env';
import type { TrackingConfig } from '../types';
import { flushDeviceEvents, handleSyncResponse, recordDeviceEvent, setTrackerState, type LocationPermission, type TrackerImpl } from './index';

interface BufferedFix {
  uuid: string;
  timestamp: string;
  is_moving: boolean;
  coords: { latitude: number; longitude: number; accuracy: number; speed?: number; heading?: number };
  battery?: { level: number; is_charging: boolean };
}

/** Heartbeat at least this often, so a parked car isn't taken for a lost phone. */
const MAX_HEARTBEAT_MS = 2 * 60_000;
/** A keepalive request (sent as the page is hidden) must stay under 64 KB. */
const KEEPALIVE_BATCH = 100;
/**
 * Fixes this vague several times running mean the phone only gives an
 * approximate location (iPhone: Precise Location off). They're too coarse for
 * distance or stop arrival, which ignore fixes worse than ~75 m.
 */
const COARSE_M = 1000;
const COARSE_RUN = 3;
const COARSE_HELP = isIOS
  ? 'Location is only approximate. Turn on Precise Location: Settings › Privacy & Security › Location Services › Safari Websites.'
  : 'Location is only approximate. Allow precise location for this site.';

let watchId: number | null = null;
let timers: number[] = [];
let buffer: BufferedFix[] = [];
let current: TrackingConfig | null = null;
let last: BufferedFix | null = null;
let sentAny = false;
let coarseRun = 0;
let coarseReported = false;
let cleanup: (() => void)[] = [];
let wakeLock: WakeLockSentinel | null = null;

async function battery(): Promise<BufferedFix['battery']> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> };
  if (!nav.getBattery) return undefined;
  try {
    const b = await nav.getBattery();
    return { level: b.level, is_charging: b.charging };
  } catch {
    return undefined;
  }
}

/** Send buffered fixes. `keepalive` lets the request finish after the page is hidden. */
async function sync(keepalive = false) {
  if (!current || buffer.length === 0 || !navigator.onLine) return;
  const batch = buffer.slice(0, keepalive ? KEEPALIVE_BATCH : 200);
  try {
    const res = await fetch(current.locationsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.token}` },
      body: JSON.stringify({ location: batch }),
      keepalive,
    });
    if (res.ok) {
      const sent = new Set(batch.map((f) => f.uuid));
      buffer = buffer.filter((f) => !sent.has(f.uuid));
      sentAny = true;
    }
    await handleSyncResponse(res.status, await res.text());
  } catch {
    /* keep buffered */
  }
}

async function heartbeat() {
  if (!current) return;
  try {
    const res = await fetch(current.heartbeatUrl, { method: 'POST', headers: { Authorization: `Bearer ${current.token}` } });
    await handleSyncResponse(res.status, await res.text());
  } catch {
    /* offline: the next one will get through */
  }
}

/** Keep the screen from locking while the trip page is open (it would pause tracking). */
async function keepScreenOn() {
  if (!current || wakeLock || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    setTrackerState({ screenAwake: true });
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      setTrackerState({ screenAwake: false });
    });
  } catch {
    /* refused, e.g. battery saver on */
  }
}

async function onPosition(pos: GeolocationPosition) {
  const fix: BufferedFix = {
    uuid: crypto.randomUUID(),
    timestamp: new Date(pos.timestamp).toISOString(),
    is_moving: (pos.coords.speed ?? 0) > 1,
    coords: {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      speed: pos.coords.speed ?? undefined,
      heading: pos.coords.heading ?? undefined,
    },
    battery: await battery(),
  };
  coarseRun = pos.coords.accuracy > COARSE_M ? coarseRun + 1 : 0;
  const coarse = coarseRun >= COARSE_RUN;
  setTrackerState({ lastFix: { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy, at: fix.timestamp }, gpsError: coarse ? COARSE_HELP : null });
  if (coarse && !coarseReported) {
    // On the admin's timeline; not an outage, so it doesn't count as location off.
    coarseReported = true;
    void recordDeviceEvent('PERMISSION_CHANGED', { details: { status: `Approximate location only (about ${Math.round(pos.coords.accuracy / 1000)} km): precise location is off` } });
  }
  // Keep a point every ~50 m or ~30 s.
  const moved = last ? haversineM({ lat: last.coords.latitude, lng: last.coords.longitude }, { lat: fix.coords.latitude, lng: fix.coords.longitude }) : Infinity;
  const elapsed = last ? pos.timestamp - new Date(last.timestamp).getTime() : Infinity;
  if (moved < 50 && elapsed < 30_000) return;
  last = fix;
  buffer.push(fix);
  // The first fix goes straight away, so the trip's start is on record even if the phone is locked right after.
  if (!sentAny || buffer.length >= 5) void sync();
}

function onError(err: GeolocationPositionError) {
  if (err.code === err.PERMISSION_DENIED) {
    setTrackerState({ gpsError: 'Location is blocked for Fleet' });
    void recordDeviceEvent('LOCATION_OFF', { details: { reason: 'permission denied' } });
  } else if (err.code === err.POSITION_UNAVAILABLE) {
    setTrackerState({ gpsError: 'No GPS signal. Is location turned on?' });
  }
  // TIMEOUT: the watch keeps trying.
}

export const webTracker: TrackerImpl = {
  async start(config) {
    await this.stop();
    current = config;
    if (!('geolocation' in navigator)) throw new Error('This browser has no GPS access');
    watchId = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 10_000, timeout: 60_000 });
    timers.push(window.setInterval(() => void sync(), 30_000));
    timers.push(
      window.setInterval(
        () => {
          if (!current) return;
          void heartbeat();
          if (last) buffer.push({ ...last, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), is_moving: false });
          void sync();
        },
        Math.min(config.heartbeatIntervalMin * 60_000, MAX_HEARTBEAT_MS),
      ),
    );
    void heartbeat();
    void keepScreenOn();

    const online = () => {
      void recordDeviceEvent('ONLINE');
      void flushDeviceEvents();
      void sync();
    };
    const offline = () => void recordDeviceEvent('OFFLINE');
    // Back in front after the phone was locked or another app was used: catch up at once.
    const visibility = () => {
      if (document.visibilityState === 'visible') {
        void keepScreenOn();
        void heartbeat();
        void sync();
        void flushDeviceEvents();
        navigator.geolocation.getCurrentPosition(onPosition, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 });
      } else {
        void sync(true);
      }
    };
    const pagehide = () => void sync(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    cleanup.push(
      () => window.removeEventListener('online', online),
      () => window.removeEventListener('offline', offline),
      () => document.removeEventListener('visibilitychange', visibility),
      () => window.removeEventListener('pagehide', pagehide),
    );
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      const change = () => void recordDeviceEvent(status.state === 'granted' ? 'LOCATION_ON' : 'LOCATION_OFF', { details: { permission: status.state } });
      status.addEventListener('change', change);
      cleanup.push(() => status.removeEventListener('change', change));
    } catch {
      /* Permissions API not available */
    }
  },

  async stop() {
    await sync();
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    timers.forEach((t) => clearInterval(t));
    timers = [];
    cleanup.forEach((f) => f());
    cleanup = [];
    await wakeLock?.release().catch(() => {});
    wakeLock = null;
    current = null;
    last = null;
    sentAny = false;
    coarseRun = 0;
    coarseReported = false;
    setTrackerState({ lastFix: null, gpsError: null, screenAwake: false });
  },

  async reconfigure(config) {
    current = config;
    void sync();
  },

  async permission() {
    if (!('geolocation' in navigator)) return 'unsupported';
    try {
      const s = await navigator.permissions.query({ name: 'geolocation' });
      return s.state === 'granted' ? 'always' : s.state === 'denied' ? 'denied' : 'prompt';
    } catch {
      return 'prompt';
    }
  },

  async requestPermission() {
    return new Promise<LocationPermission>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => resolve('always'),
        (e) => resolve(e.code === e.PERMISSION_DENIED ? 'denied' : 'prompt'),
        { enableHighAccuracy: true, timeout: 20_000 },
      );
    });
  },
};
