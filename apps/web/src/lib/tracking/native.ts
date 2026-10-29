/**
 * Background tracking on iOS/Android with Transistorsoft's plugin: motion
 * detection, a heartbeat while stationary, `providerchange` (location off or
 * permission changed), an offline SQLite buffer and HTTP auto-sync.
 * Android release builds need the paid licence key in AndroidManifest.xml.
 */
import BackgroundGeolocation, { type Subscription } from '@transistorsoft/capacitor-background-geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';
import { haversineM } from '@carbooking/core';
import { post } from '../api';
import type { TrackingConfig } from '../types';
import { flushDeviceEvents, handleSyncResponse, loadTrackingSession, recordDeviceEvent, setTrackerState, updateTrackingConfig, type LocationPermission, type TrackerImpl } from './index';

const OFFICE_GEOFENCE = 'office';
let subscriptions: Subscription[] = [];
let lastOfficePrompt = 0;

function permissionFrom(status: number): LocationPermission {
  switch (status) {
    case BackgroundGeolocation.AUTHORIZATION_STATUS_ALWAYS:
      return 'always';
    case BackgroundGeolocation.AUTHORIZATION_STATUS_WHEN_IN_USE:
      return 'whenInUse';
    case BackgroundGeolocation.AUTHORIZATION_STATUS_NOT_DETERMINED:
      return 'prompt';
    default:
      return 'denied';
  }
}

function httpConfig(config: TrackingConfig) {
  return {
    url: config.locationsUrl,
    headers: { Authorization: `Bearer ${config.token}` },
    httpRootProperty: 'location',
    autoSync: true,
    batchSync: true,
    maxBatchSize: 100,
    params: { tripId: config.tripId },
  };
}

async function promptEndTrip(config: TrackingConfig) {
  if (Date.now() - lastOfficePrompt < 10 * 60_000) return;
  lastOfficePrompt = Date.now();
  const session = await loadTrackingSession();
  await LocalNotifications.schedule({
    notifications: [
      {
        id: 1001,
        title: 'Back at the office?',
        body: 'End the trip and enter the odometer reading.',
        extra: { link: `/trips/${session?.bookingId ?? ''}?end=1` },
      },
    ],
  }).catch(() => {});
  void config;
}

function listen(config: TrackingConfig) {
  subscriptions.forEach((s) => s.remove());
  subscriptions = [
    BackgroundGeolocation.onLocation((loc) => {
      setTrackerState({ lastFix: { lat: loc.coords.latitude, lng: loc.coords.longitude, accuracy: loc.coords.accuracy ?? null, at: loc.timestamp } });
    }),
    // A position every heartbeat while stationary, so the server knows we're alive.
    BackgroundGeolocation.onHeartbeat(() => {
      void BackgroundGeolocation.getCurrentPosition({ samples: 1, persist: true, extras: { heartbeat: true }, timeout: 30 }).catch(() => {});
    }),
    // Location services switched off, or permission downgraded from "Always".
    BackgroundGeolocation.onProviderChange((e) => {
      const perm = permissionFrom(e.status);
      if (!e.enabled) void recordDeviceEvent('LOCATION_OFF', { details: { gps: e.gps, network: e.network } });
      else if (perm !== 'always') void recordDeviceEvent('PERMISSION_CHANGED', { details: { always: false, status: perm } });
      else void recordDeviceEvent('LOCATION_ON', { details: { gps: e.gps, network: e.network } });
      if (e.enabled && perm === 'always') void recordDeviceEvent('PERMISSION_CHANGED', { details: { always: true, status: perm } });
    }),
    // The device's own network log, uploaded after reconnecting.
    BackgroundGeolocation.onConnectivityChange((e) => {
      void recordDeviceEvent(e.connected ? 'ONLINE' : 'OFFLINE');
      if (e.connected) {
        void flushDeviceEvents();
        void BackgroundGeolocation.sync().catch(() => {});
      }
    }),
    BackgroundGeolocation.onGeofence((e) => {
      if (e.identifier !== OFFICE_GEOFENCE) return;
      const lat = e.location?.coords.latitude;
      const lng = e.location?.coords.longitude;
      if (e.action === 'ENTER') {
        void recordDeviceEvent('GEOFENCE_ENTER', { lat, lng });
        void BackgroundGeolocation.changePace(true).catch(() => {});
      } else if (e.action === 'EXIT') {
        void recordDeviceEvent('GEOFENCE_EXIT', { lat, lng });
      } else if (e.action === 'DWELL' && lat != null && lng != null) {
        // Stopped near the office for a couple of minutes: check the 20 m parking zone.
        const d = haversineM({ lat, lng }, config.office);
        const allowance = Math.min(e.location?.coords.accuracy ?? 0, config.office.arrivalRadiusM);
        if (d <= config.office.arrivalRadiusM + allowance) void promptEndTrip(config);
      }
    }),
    BackgroundGeolocation.onHttp(async (res) => {
      if (res.status === 401) {
        // Tracking token expired (e.g. a long overrun): get a fresh one.
        try {
          const fresh = await post<TrackingConfig>(`/trips/${config.tripId}/tracking-token`);
          await updateTrackingConfig(fresh);
        } catch {
          /* try again on the next sync */
        }
        return;
      }
      await handleSyncResponse(res.status, res.responseText);
    }),
  ];
}

export const nativeTracker: TrackerImpl = {
  async start(config) {
    listen(config);
    await BackgroundGeolocation.ready({
      reset: true,
      desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_HIGH,
      distanceFilter: 50,
      locationUpdateInterval: 30_000,
      fastestLocationUpdateInterval: 15_000,
      stopTimeout: 5,
      heartbeatInterval: config.heartbeatIntervalMin * 60,
      preventSuspend: true,
      stopOnTerminate: false,
      startOnBoot: true,
      enableHeadless: true,
      foregroundService: true,
      locationAuthorizationRequest: 'Always',
      showsBackgroundLocationIndicator: true,
      geofenceModeHighAccuracy: true,
      maxDaysToPersist: 7,
      logLevel: BackgroundGeolocation.LOG_LEVEL_WARNING,
      notification: { title: 'Trip tracking active', text: 'Location is recorded until you end the trip.' },
      backgroundPermissionRationale: {
        title: 'Allow location "All the time" during trips',
        message: 'Trips are tracked from start until the car is back at the office, even when the phone is locked. Tracking stops when the trip ends.',
        positiveAction: 'Change to "Allow all the time"',
        negativeAction: 'Cancel',
      },
      ...httpConfig(config),
    });
    await BackgroundGeolocation.removeGeofences();
    await BackgroundGeolocation.addGeofence({
      identifier: OFFICE_GEOFENCE,
      latitude: config.office.lat,
      longitude: config.office.lng,
      radius: Math.max(config.office.wakeupRadiusM, 150),
      notifyOnEntry: true,
      notifyOnExit: true,
      notifyOnDwell: true,
      loiteringDelay: config.officeDwellMin * 60_000,
    });
    await BackgroundGeolocation.start();
    await BackgroundGeolocation.changePace(true);
  },

  async stop() {
    await BackgroundGeolocation.sync().catch(() => {});
    await BackgroundGeolocation.removeGeofences().catch(() => {});
    await BackgroundGeolocation.stop();
    subscriptions.forEach((s) => s.remove());
    subscriptions = [];
  },

  async reconfigure(config) {
    await BackgroundGeolocation.setConfig(httpConfig(config));
    listen(config);
    await BackgroundGeolocation.sync().catch(() => {});
  },

  async permission() {
    const s = await BackgroundGeolocation.getProviderState();
    return s.enabled ? permissionFrom(s.status) : 'denied';
  },

  async requestPermission() {
    try {
      return permissionFrom(await BackgroundGeolocation.requestPermission());
    } catch (status) {
      return permissionFrom(Number(status));
    }
  },
};
