/**
 * Trip tracking. Runs only between trip start and trip end (privacy on
 * personal phones). The native app uses the Transistorsoft background
 * geolocation plugin; a desktop browser can run a foreground-only version in
 * development.
 */
import { useEffect, useState } from 'react';
import type { DEVICE_EVENT_TYPES } from '@carbooking/core';
import { isNative } from '../env';
import type { TrackingConfig } from '../types';
import { store } from './store';

export type DeviceEventType = (typeof DEVICE_EVENT_TYPES)[number];
export type LocationPermission = 'always' | 'whenInUse' | 'denied' | 'prompt' | 'unsupported';

export interface TrackingSession {
  bookingId: string;
  config: TrackingConfig;
}

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number | null;
  at: string;
}

export interface TrackerImpl {
  start(config: TrackingConfig): Promise<void>;
  stop(): Promise<void>;
  permission(): Promise<LocationPermission>;
  requestPermission(): Promise<LocationPermission>;
  /** Update the URL/token without restarting (e.g. after the token is refreshed). */
  reconfigure(config: TrackingConfig): Promise<void>;
}

const SESSION_KEY = 'fleet.tracking.session';
const EVENTS_KEY = 'fleet.tracking.events';

let implPromise: Promise<TrackerImpl> | null = null;
const impl = () => (implPromise ??= isNative ? import('./native').then((m) => m.nativeTracker) : import('./web').then((m) => m.webTracker));

// ── Shared state for the UI ───────────────────────────────────────────────────

interface TrackerState {
  active: boolean;
  lastFix: Fix | null;
  lastSyncAt: string | null;
  pendingEvents: number;
}
let state: TrackerState = { active: false, lastFix: null, lastSyncAt: null, pendingEvents: 0 };
const subs = new Set<(s: TrackerState) => void>();
export function setTrackerState(patch: Partial<TrackerState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f(state));
}
export function useTrackerState() {
  const [s, set] = useState(state);
  useEffect(() => {
    subs.add(set);
    return () => void subs.delete(set);
  }, []);
  return s;
}

// ── Session ───────────────────────────────────────────────────────────────────

export const loadTrackingSession = () => store.get<TrackingSession>(SESSION_KEY);
export const saveTrackingSession = (s: TrackingSession) => store.set(SESSION_KEY, s);

export async function startTracking(config: TrackingConfig) {
  await (await impl()).start(config);
  setTrackerState({ active: true });
}

export async function stopTracking() {
  try {
    await flushDeviceEvents();
    await (await impl()).stop();
  } finally {
    await store.remove(SESSION_KEY);
    setTrackerState({ active: false });
  }
}

/** On app launch: keep tracking a trip that was running when the app closed. */
export async function resumeTracking() {
  const s = await loadTrackingSession();
  if (!s) return null;
  if (new Date(s.config.expiresAt) < new Date()) {
    await store.remove(SESSION_KEY);
    return null;
  }
  await startTracking(s.config);
  void flushDeviceEvents();
  return s;
}

export async function updateTrackingConfig(config: TrackingConfig) {
  const s = await loadTrackingSession();
  if (s) await saveTrackingSession({ ...s, config });
  await (await impl()).reconfigure(config);
}

export async function locationPermission() {
  return (await impl()).permission();
}
export async function requestLocationPermission() {
  return (await impl()).requestPermission();
}

// ── Device events (location off/on, network log, geofence) ────────────────────

interface QueuedEvent {
  clientEventId: string;
  type: DeviceEventType;
  occurredAt: string;
  details?: Record<string, unknown>;
  lat?: number;
  lng?: number;
  battery?: number;
}

/** Record an event with the device's time; it is sent now or after reconnecting. */
export async function recordDeviceEvent(type: DeviceEventType, extra: Omit<QueuedEvent, 'clientEventId' | 'type' | 'occurredAt'> = {}) {
  const queue = (await store.get<QueuedEvent[]>(EVENTS_KEY)) ?? [];
  queue.push({ clientEventId: crypto.randomUUID(), type, occurredAt: new Date().toISOString(), ...extra });
  await store.set(EVENTS_KEY, queue.slice(-500));
  setTrackerState({ pendingEvents: queue.length });
  void flushDeviceEvents();
}

let flushingEvents = false;
export async function flushDeviceEvents() {
  if (flushingEvents) return;
  const session = await loadTrackingSession();
  const queue = (await store.get<QueuedEvent[]>(EVENTS_KEY)) ?? [];
  if (!session || queue.length === 0) return;
  flushingEvents = true;
  try {
    const res = await fetch(session.config.eventsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.config.token}` },
      body: JSON.stringify({ events: queue.slice(0, 500) }),
    });
    if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429)) {
      const sent = new Set(queue.slice(0, 500).map((e) => e.clientEventId));
      const rest = ((await store.get<QueuedEvent[]>(EVENTS_KEY)) ?? []).filter((e) => !sent.has(e.clientEventId));
      await store.set(EVENTS_KEY, rest);
      setTrackerState({ pendingEvents: rest.length });
    }
  } catch {
    /* offline: keep for later */
  } finally {
    flushingEvents = false;
  }
}

/** Handle the API's reply to a location sync: stop when the trip is over. */
export async function handleSyncResponse(status: number, body: string) {
  if (status === 200) {
    setTrackerState({ lastSyncAt: new Date().toISOString() });
    try {
      const json = JSON.parse(body) as { stopTracking?: boolean };
      if (json.stopTracking) await stopTracking();
    } catch {
      /* ignore */
    }
  }
}
