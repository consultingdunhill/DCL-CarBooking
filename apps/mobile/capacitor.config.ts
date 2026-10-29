import type { CapacitorConfig } from '@capacitor/cli';

// The native app wraps the same React build as the web app (apps/web/dist).
// Build it with VITE_API_URL pointing at the public API, not localhost.
const config: CapacitorConfig = {
  // Also the URL scheme for Microsoft sign-in: register `<appId>://auth`
  // (VITE_ENTRA_NATIVE_REDIRECT) as a mobile redirect URI in Entra.
  appId: 'ke.co.fleet.app',
  appName: 'Fleet',
  webDir: '../web/dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    LocalNotifications: {
      iconColor: '#0f5e57',
    },
  },
};

export default config;
