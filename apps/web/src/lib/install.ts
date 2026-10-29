import { useSyncExternalStore } from 'react';
import { isNative } from './env';

/** Chrome/Edge's install event (not in the DOM typings). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * How this browser can put Fleet on the home screen:
 * - `installed`: the native app, or already opened from the home screen
 * - `prompt`: the browser can show its own install dialog (Chrome/Edge)
 * - `ios`: Share → Add to Home Screen, by hand
 * - `android`: browser menu → Install app, by hand (no dialog offered yet)
 * - `none`: a desktop browser that can't install
 */
export type InstallMode = 'installed' | 'prompt' | 'ios' | 'android' | 'none';

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
/** iPhone or iPad (iPads report a Mac user agent, but have a touch screen). */
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
export const isPhone = isIOS || isAndroid;

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Call once at startup: Chrome fires its install event early, often before any screen has mounted. */
export function listenForInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // our own card replaces Chrome's mini-infobar
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    emit();
  });
}

function getMode(): InstallMode {
  if (isNative || installed || isStandalone()) return 'installed';
  if (deferred) return 'prompt';
  if (isIOS) return 'ios';
  if (isAndroid) return 'android';
  return 'none';
}

export function useInstallMode() {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, getMode);
}

/** Show the browser's install dialog (from a user tap). Resolves true if they installed. */
export async function promptInstall() {
  const e = deferred;
  if (!e) return false;
  await e.prompt();
  const { outcome } = await e.userChoice;
  deferred = null; // each event can prompt only once
  emit();
  return outcome === 'accepted';
}
