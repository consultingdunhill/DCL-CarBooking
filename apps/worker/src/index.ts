/**
 * Background jobs (pg-boss, on the app database):
 *  - tracking monitor: heartbeat → Offline / Tracking lost; office arrival → AWAITING_ODOMETER
 *  - tracker sync: pull hardware-tracker fixes for running trips (when TRACKER_PROVIDER is set)
 *  - overdue: ETA + grace → push owner, then admins by push + SMS/WhatsApp
 *  - no-show: not started within the window → released
 *  - awaiting-odometer reminders
 *  - GPS retention (raw points kept for the retention period)
 *  - notification dispatch (push, email, SMS/WhatsApp)
 *  - the linked WhatsApp device, when WHATSAPP_PROVIDER=baileys
 *  - the CRM's portfolio, then its signed deals (as closures), nightly, when CRM_API_URL is set
 *  - viewings (stops booked for CRM leads) pushed back to the CRM as they change
 */
import { prisma } from '@carbooking/db';
import {
  crmEnabled,
  dispatchNotifications,
  getBoss,
  pushCrmViewings,
  QUEUES,
  runAwaitingOdometerReminders,
  runDispatchSweep,
  runGpsRetention,
  runNoShowCheck,
  runOverdueCheck,
  runTrackerSync,
  runTrackingMonitor,
  startWhatsapp,
  stopBoss,
  stopWhatsapp,
  syncCrmDeals,
  syncCrmProperties,
} from '@carbooking/server';

const boss = await getBoss({ worker: true });
await startWhatsapp().catch((err) => console.error('[whatsapp] could not start', err));

/** Run a periodic check, logging rather than crashing on failure. */
const periodic = (name: string, fn: (now: Date) => Promise<unknown>) => async () => {
  const started = Date.now();
  try {
    await fn(new Date());
  } catch (err) {
    console.error(`[${name}] failed`, err);
    throw err;
  } finally {
    const ms = Date.now() - started;
    if (ms > 5000) console.warn(`[${name}] took ${ms} ms`);
  }
};

// Cron runs at most once a minute; every minute is right for a 5-minute heartbeat.
const schedules: [string, string, (now: Date) => Promise<unknown>][] = [
  [QUEUES.trackingMonitor, '* * * * *', runTrackingMonitor],
  [QUEUES.trackerSync, '* * * * *', runTrackerSync],
  [QUEUES.overdue, '* * * * *', runOverdueCheck],
  [QUEUES.noShow, '* * * * *', runNoShowCheck],
  [QUEUES.awaitingOdometer, '*/5 * * * *', async (now) => {
    await runAwaitingOdometerReminders(now);
    await runDispatchSweep(now);
  }],
  [QUEUES.retention, '30 2 * * *', runGpsRetention],
  // 04:00 in Nairobi: an hour after the CRM's own nightly scrape of the website.
  // Deals second, so a listing added today is here for its deal to match.
  [QUEUES.crmSync, '0 1 * * *', async () => {
    if (!crmEnabled()) return;
    console.log('[crm.sync]', await syncCrmProperties());
    console.log('[crm.sync-deals]', await syncCrmDeals());
  }],
  [QUEUES.crmViewings, '* * * * *', async (now) => {
    const r = await pushCrmViewings(now);
    if (r.pushed || r.failed.length) console.log('[crm.push-viewings]', r);
  }],
];

for (const [queue, cron, fn] of schedules) {
  await boss.schedule(queue, cron, undefined, { tz: 'UTC', singletonKey: queue });
  await boss.work(queue, { batchSize: 1 }, periodic(queue, fn));
}

await boss.work<{ ids: string[] }>(QUEUES.dispatch, { batchSize: 5 }, async (jobs) => {
  await dispatchNotifications(jobs.flatMap((j) => j.data.ids));
});

// Catch anything queued while the worker was down.
await runDispatchSweep(new Date()).catch((err) => console.error('[dispatch-sweep]', err));

console.log(`Worker running: ${schedules.map(([q, c]) => `${q} (${c})`).join(', ')}, ${QUEUES.dispatch}`);

const shutdown = async () => {
  await stopWhatsapp();
  await stopBoss();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
