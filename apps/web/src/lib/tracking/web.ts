/**
 * Foreground-only tracking in a browser, for development and demos
 * (VITE_ALLOW_WEB_TRIPS). Stops when the tab is closed or the screen locks —
 * real trips use the native app.
 */
import { haversineM } from '@carbooking/core';
import type { TrackingConfig } from '../types';
import { flushDeviceEvents, handleSyncResponse, recordDeviceEvent, setTrackerState, type LocationPermission, type TrackerImpl } from './index';

interface BufferedFix {
  uuid: string;
  timestamp: string;
  is_moving: boolean;
  coords: { latitude: number; longitude: number; accuracy: number; speed?: number; heading?: number };
  battery?: { level: number; is_charging: boolean };
}

let watchId: number | null = null;
let timers: number[] = [];
let buffer: BufferedFix[] = [];
let current: TrackingConfig | null = null;
let last: BufferedFix | null = null;
let cleanup: (() => void)[] = [];

async function battery(): Promise<BufferedFix['battery']> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> };
  if (!nav.getBattery) return undefined;
  const b = await nav.getBattery();
  return { level: b.level, is_charging: b.charging };
}

async function sync() {
  if (!current || buffer.length === 0 || !navigator.onLine) return;
  const batch = buffer.slice(0, 200);
  try {
    const res = await fetch(current.locationsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.token}` },
      body: JSON.stringify({ location: batch }),
    });
    if (res.ok) buffer = buffer.slice(batch.length);
    await handleSyncResponse(res.status, await res.text());
  } catch {
    /* keep buffered */
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
  // Keep a point every ~50 m or ~30 s.
  const moved = last ? haversineM({ lat: last.coords.latitude, lng: last.coords.longitude }, { lat: fix.coords.latitude, lng: fix.coords.longitude }) : Infinity;
  const elapsed = last ? pos.timestamp - new Date(last.timestamp).getTime() : Infinity;
  setTrackerState({ lastFix: { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy, at: fix.timestamp } });
  if (moved < 50 && elapsed < 30_000) return;
  last = fix;
  buffer.push(fix);
  if (buffer.length >= 5) void sync();
}

function onError(err: GeolocationPositionError) {
  if (err.code === err.PERMISSION_DENIED) void recordDeviceEvent('LOCATION_OFF', { details: { reason: 'permission denied' } });
}

export const webTracker: TrackerImpl = {
  async start(config) {
    await this.stop();
    current = config;
    if (!('geolocation' in navigator)) throw new Error('This browser has no GPS access');
    watchId = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 10_000, timeout: 60_000 });
    timers.push(window.setInterval(() => void sync(), 30_000));
    timers.push(
      window.setInterval(async () => {
        if (!current) return;
        await fetch(current.heartbeatUrl, { method: 'POST', headers: { Authorization: `Bearer ${current.token}` } }).catch(() => {});
        if (last) buffer.push({ ...last, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), is_moving: false });
        void sync();
      }, config.heartbeatIntervalMin * 60_000),
    );
    const online = () => {
      void recordDeviceEvent('ONLINE');
      void flushDeviceEvents();
      void sync();
    };
    const offline = () => void recordDeviceEvent('OFFLINE');
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    cleanup.push(() => window.removeEventListener('online', online), () => window.removeEventListener('offline', offline));
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
    current = null;
    last = null;
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
