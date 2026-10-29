import PgBoss from 'pg-boss';
import { pgConnectionString } from './env';

export const QUEUES = {
  dispatch: 'notify.dispatch',
  trackingMonitor: 'trips.tracking-monitor',
  overdue: 'trips.overdue',
  noShow: 'bookings.no-show',
  awaitingOdometer: 'trips.awaiting-odometer',
  retention: 'gps.retention',
  crmSync: 'crm.sync',
} as const;

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

/**
 * pg-boss on the app database. The API only sends jobs (no maintenance or
 * cron); the worker runs schedules and handlers.
 */
export function getBoss(opts: { worker: boolean }): Promise<PgBoss> {
  if (boss) return Promise.resolve(boss);
  if (!starting) {
    starting = (async () => {
      const b = new PgBoss({
        connectionString: pgConnectionString(),
        supervise: opts.worker,
        schedule: opts.worker,
      });
      b.on('error', (err) => console.error('[pg-boss]', err));
      await b.start();
      for (const name of Object.values(QUEUES)) {
        try {
          await b.createQueue(name);
        } catch {
          /* already exists */
        }
      }
      boss = b;
      return b;
    })().catch((err) => {
      starting = null;
      throw err;
    });
  }
  return starting;
}

export async function stopBoss() {
  if (boss) await boss.stop({ graceful: true });
  boss = null;
  starting = null;
}
