import { useEffect } from 'react';
import { get, post } from './api';
import { isNative, platform } from './env';

const b64ToUint8 = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export function pushSupported() {
  return isNative || ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  if (isNative) return 'default';
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

/** Ask for permission (from a user tap) and register this device for push. */
export async function enablePush(): Promise<boolean> {
  if (isNative) return registerNative(true);
  if (!pushSupported()) return false;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  return registerWeb();
}

async function registerWeb(): Promise<boolean> {
  const { vapidPublicKey } = await get<{ vapidPublicKey: string | null }>('/push/config');
  if (!vapidPublicKey) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(vapidPublicKey) }));
  const json = sub.toJSON();
  await post('/push/subscriptions', { kind: 'WEB', endpoint: json.endpoint, keys: json.keys });
  return true;
}

async function registerNative(prompt: boolean): Promise<boolean> {
  const { PushNotifications } = await import('@capacitor/push-notifications');
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === 'prompt' && prompt) perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') return false;
  await PushNotifications.removeAllListeners();
  await PushNotifications.addListener('registration', ({ value }) => {
    void post('/push/subscriptions', { kind: 'FCM', token: value, platform });
  });
  await PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
    const link = (notification.data as { link?: string } | undefined)?.link;
    if (link) window.location.assign(link);
  });
  await PushNotifications.register();
  return true;
}

/** Keep this device registered for push once permission has been given. */
export function usePushRegistration() {
  useEffect(() => {
    (async () => {
      try {
        if (isNative) await registerNative(true);
        else if (pushPermission() === 'granted' && 'serviceWorker' in navigator) await registerWeb();
      } catch (err) {
        console.warn('Push registration failed', err);
      }
    })();
  }, []);
}
