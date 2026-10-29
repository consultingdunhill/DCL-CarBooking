import { Capacitor } from '@capacitor/core';

const e = import.meta.env;
const blank = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export const ENV = {
  apiUrl: (blank(e.VITE_API_URL) ?? 'http://localhost:4000').replace(/\/$/, ''),
  authMode: (blank(e.VITE_AUTH_MODE) ?? 'dev') as 'dev' | 'entra',
  entraClientId: blank(e.VITE_ENTRA_CLIENT_ID),
  entraTenantId: blank(e.VITE_ENTRA_TENANT_ID),
  entraApiScope: blank(e.VITE_ENTRA_API_SCOPE),
  /** Custom-scheme redirect for sign-in on the native app (system browser). */
  entraNativeRedirect: blank(e.VITE_ENTRA_NATIVE_REDIRECT) ?? 'ke.co.fleet.app://auth',
  googleMapsKey: blank(e.VITE_GOOGLE_MAPS_API_KEY),
  googleMapId: blank(e.VITE_GOOGLE_MAPS_MAP_ID),
  vapidPublicKey: blank(e.VITE_VAPID_PUBLIC_KEY),
  allowWebTrips: blank(e.VITE_ALLOW_WEB_TRIPS) === 'true',
  appName: blank(e.VITE_APP_NAME) ?? 'Fleet',
};

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform() as 'web' | 'ios' | 'android';
/** Trips run on the native app; a desktop browser may run them only in development. */
export const canRunTrips = isNative || ENV.allowWebTrips;
