import { prisma } from '@carbooking/db';
import pg from 'pg';
import { pgConnectionString } from './env';

/**
 * Real-time events for the admin live map and open screens. Published with
 * Postgres NOTIFY so the worker and every API instance share one bus.
 * Payloads stay small (ids and status); clients refetch what they need.
 */
export type LiveEvent =
  | { type: 'booking.changed'; bookingId: string; status?: string }
  | { type: 'join.changed'; joinRequestId: string; bookingId: string; status?: string }
  | {
      type: 'trip.updated';
      tripId: string;
      bookingId: string;
      status: string;
      lat?: number | null;
      lng?: number | null;
      lastSeenAt?: string | null;
      battery?: number | null;
    }
  | { type: 'notification'; userId: string };

const CHANNEL = 'cb_live';

export async function publishLive(event: LiveEvent): Promise<void> {
  try {
    await prisma.$executeRaw`SELECT pg_notify(${CHANNEL}, ${JSON.stringify(event)})`;
  } catch (err) {
    console.error('[live] publish failed', err);
  }
}

/** Listen for live events. Reconnects automatically. Returns a stop function. */
export function subscribeLive(onEvent: (e: LiveEvent) => void): () => void {
  let client: pg.Client | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;

  const connect = async () => {
    client = new pg.Client({ connectionString: pgConnectionString() });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        onEvent(JSON.parse(msg.payload) as LiveEvent);
      } catch {
        /* ignore malformed payloads */
      }
    });
    client.on('error', (err) => {
      console.error('[live] listener error', err.message);
      scheduleReconnect();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      console.error('[live] listen failed', (err as Error).message);
      scheduleReconnect();
    }
  };

  const scheduleReconnect = () => {
    if (stopped || retry) return;
    client?.end().catch(() => {});
    client = null;
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, 3000);
  };

  void connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    client?.end().catch(() => {});
  };
}
