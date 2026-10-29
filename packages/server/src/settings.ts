import { resolveSettings, type Settings } from '@carbooking/core';
import { prisma } from '@carbooking/db';

let cache: { at: number; value: Settings } | null = null;
const TTL_MS = 30_000;

/** Settings merged over defaults, cached briefly. */
export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const rows = await prisma.setting.findMany();
  const value = resolveSettings(rows);
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateSettings() {
  cache = null;
}
