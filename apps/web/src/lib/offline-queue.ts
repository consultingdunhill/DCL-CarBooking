/**
 * Starting and ending a trip must work with patchy coverage. Actions are
 * timestamped on the device and kept in IndexedDB (photos included) until they
 * reach the server. Every action carries an idempotency key, so replaying one
 * that already arrived is harmless.
 */
import { ApiError, post, uploadFile } from './api';
import type { Booking, TrackingConfig, TripSummary } from './types';
import { saveTrackingSession, startTracking } from './tracking';

export type QueuedAction =
  | { kind: 'trip.start'; bookingId: string; odometer: number; photo: Blob; clientRequestId: string; startedAt: string }
  | { kind: 'trip.end'; tripId: string; bookingId: string; odometer: number; photo: Blob; clientRequestId: string; endedAt: string; method: 'MANUAL' | 'GEOFENCE' }
  | { kind: 'stop.action'; tripId: string; stopId: string; action: 'ARRIVED' | 'DEPARTED' | 'SKIPPED'; at: string };

interface Row {
  id: string;
  createdAt: string;
  action: QueuedAction;
  attempts: number;
  lastError?: string;
}

const DB = 'fleet-offline';
const STORE = 'actions';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function pending(): Promise<Row[]> {
  const rows = await tx<Row[]>('readonly', (s) => s.getAll() as IDBRequest<Row[]>);
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const listeners = new Set<() => void>();
export const onQueueChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const changed = () => listeners.forEach((f) => f());

export async function enqueue(action: QueuedAction) {
  const row: Row = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), action, attempts: 0 };
  await tx('readwrite', (s) => s.put(row));
  changed();
  void flush();
}

/** Errors that will never succeed on retry (validation, wrong state). */
const permanent = (err: unknown) => err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 408 && err.status !== 429;

async function run(a: QueuedAction) {
  switch (a.kind) {
    case 'trip.start': {
      const photoKey = await uploadFile('ODOMETER_START', a.photo);
      const res = await post<{ trip: TripSummary; tracking: TrackingConfig }>(`/bookings/${a.bookingId}/trip/start`, {
        odometer: a.odometer,
        photoKey,
        clientRequestId: a.clientRequestId,
        startedAt: a.startedAt,
      });
      await saveTrackingSession({ bookingId: a.bookingId, config: res.tracking });
      await startTracking(res.tracking);
      return;
    }
    case 'trip.end': {
      const photoKey = await uploadFile('ODOMETER_END', a.photo);
      await post<Booking>(`/trips/${a.tripId}/end`, { odometer: a.odometer, photoKey, clientRequestId: a.clientRequestId, endedAt: a.endedAt, method: a.method });
      return;
    }
    case 'stop.action':
      await post(`/trips/${a.tripId}/stops/${a.stopId}`, { action: a.action, at: a.at });
      return;
  }
}

let flushing: Promise<void> | null = null;

/** Send queued actions in order. Stops at the first network failure. */
export function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    for (const row of await pending()) {
      try {
        await run(row.action);
        await tx('readwrite', (s) => s.delete(row.id));
      } catch (err) {
        if (permanent(err)) {
          // Keep it visible so the user sees why (e.g. odometer lower than the start).
          await tx('readwrite', (s) => s.put({ ...row, attempts: row.attempts + 1, lastError: (err as Error).message }));
          await tx('readwrite', (s) => s.delete(row.id));
          failures.push({ action: row.action, message: (err as Error).message });
          continue;
        }
        await tx('readwrite', (s) => s.put({ ...row, attempts: row.attempts + 1, lastError: (err as Error).message }));
        break;
      } finally {
        changed();
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Actions the server refused, to show to the user once. */
export const failures: { action: QueuedAction; message: string }[] = [];

let started = false;
/** Retry when the connection returns and when the app comes back to the foreground. */
export function startQueue() {
  if (started) return;
  started = true;
  window.addEventListener('online', () => void flush());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void flush());
  setInterval(() => void flush(), 60_000);
  void flush();
}
