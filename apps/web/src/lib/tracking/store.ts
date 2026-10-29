import { Preferences } from '@capacitor/preferences';
import { isNative } from '../env';

/** Small persistent key/value store: Capacitor Preferences on the phone, localStorage on the web. */
export const store = {
  async get<T>(key: string): Promise<T | null> {
    const raw = isNative ? (await Preferences.get({ key })).value : localStorage.getItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
  async set(key: string, value: unknown) {
    const raw = JSON.stringify(value);
    if (isNative) await Preferences.set({ key, value: raw });
    else localStorage.setItem(key, raw);
  },
  async remove(key: string) {
    if (isNative) await Preferences.remove({ key });
    else localStorage.removeItem(key);
  },
};
