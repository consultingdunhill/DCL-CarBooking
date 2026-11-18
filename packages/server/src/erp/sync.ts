/**
 * Keep ERPNext's read-only copy of Fleet current: cars, bookings (with stops, trip and
 * costs), fuel entries and each car's monthly figures.
 *
 * Fleet stays the system of record. Every run builds what each record should look like in
 * ERPNext, hashes it, and sends only the ones whose hash changed since the last successful
 * send (ErpSyncState). Records gone from Fleet are deleted from ERPNext. Costs come from the
 * same code as Fleet's own reports (costedTripsAndCarMonths), so the two always agree.
 *
 * Order matters because ERPNext checks links: cars first, deletions the other way round.
 * The copy mirrors the CRM's (the CRM's app/services/erp_sync.py), and stops link to the
 * CRM's listings and leads there when those exist.
 */
import { createHash } from 'node:crypto';
import { costedTripsAndCarMonths, type CarMonthStats, type CostedTrip } from '@carbooking/core';
import { num, prisma } from '@carbooking/db';
import { env } from '../env';
import { loadDataset } from '../report-data';
import { getSettings } from '../settings';
import { ErpClient, ErpError } from './client';
import * as schema from './schema';

/** A record that failed is retried each run, but at most this often while it is unchanged. */
const RETRY_FAILED_AFTER_MS = 30 * 60_000;
/** No run for this long means the worker has stopped (or the sync isn't scheduled). */
const STALE_AFTER_MS = 15 * 60_000;
export const HEALTH_KEY = 'erp_sync_health';
export const INTERVAL_MINUTES = 2;

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);
export const carRef = (id: string) => `CAR-${short(id)}`;
export const bookingRef = (id: string) => `BK-${short(id)}`;
export const fuelRef = (id: string) => `FUEL-${short(id)}`;
export const carMonthRef = (carId: string, month: string) => `CM-${short(carId)}-${month}`;
/** The CRM names its copies "PROP-0042" and "LEAD-0042" (its erp_sync.listing_ref, lead_ref). */
const crmListingRef = (crmRef: string | null | undefined) => {
  const m = /^dq:(\d+)$/.exec(crmRef ?? '');
  return m ? `PROP-${m[1]!.padStart(4, '0')}` : null;
};
const crmLeadRef = (ref: string | null | undefined) => (/^[1-9]\d*$/.test(ref ?? '') ? `LEAD-${ref!.padStart(4, '0')}` : null);
const STRAY_PREFIXES: Record<string, string> = { [schema.CAR]: 'CAR-', [schema.BOOKING]: 'BK-', [schema.FUEL]: 'FUEL-', [schema.CAR_MONTH]: 'CM-' };

// -- values ---------------------------------------------------------------------------------

/** ERPNext Datetime fields are naive local times in the site's zone. */
export function erpDatetime(d: Date | null | undefined, tz: string): string | null {
  if (!d) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
const erpDate = (d: Date | null | undefined, tz: string) => erpDatetime(d, tz)?.slice(0, 10) ?? null;
const money = (n: number | null | undefined) => (n == null ? null : Math.round(n * 100) / 100);
const check = (b: boolean | null | undefined) => (b ? 1 : 0);
const when = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const fleetUrl = (path: string) => `${env.APP_URL.replace(/\/+$/, '')}${path}`;

/** Trim Data values to their column, here and in child rows. ERPNext refuses longer ones. */
export function fit(doctype: string, doc: Record<string, unknown>): Record<string, unknown> {
  const fields = schema.fieldsOf(doctype);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    const f = fields.get(key);
    if (f?.fieldtype === 'Data' && typeof value === 'string') out[key] = value.slice(0, f.length ?? schema.DATA_DEFAULT_LENGTH);
    else if (f?.fieldtype === 'Table' && Array.isArray(value)) out[key] = value.map((row) => fit(f.options!, row));
    else out[key] = value;
  }
  return out;
}

/** sha256 of the document with its keys sorted, so the same content always hashes the same. */
export function payloadHash(doc: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(doc))).digest('hex');
}

// -- what each doctype holds -------------------------------------------------------------------

interface Rec {
  fleetId: string;
  name: string;
  doc: Record<string, unknown>;
}

interface Context {
  tz: string;
  split: string;
  /** The CRM's copies already in ERPNext, so a stop links only to what is there. */
  crmListings: Set<string>;
  crmLeads: Set<string>;
}

async function cars(ctx: Context): Promise<Rec[]> {
  const rows = await prisma.car.findMany({ orderBy: { registration: 'asc' } });
  return rows.map((c) => ({
    fleetId: c.id,
    name: carRef(c.id),
    doc: {
      fleet_ref: carRef(c.id),
      registration: c.registration,
      make: c.make,
      model: c.model,
      color: c.color,
      seats: c.seats,
      status: schema.label(c.status),
      fuel_type: schema.label(c.fuelType),
      odometer: c.currentOdometer,
      has_tracker: check(Boolean(c.trackerDeviceId)),
      notes: c.notes,
      fleet_url: fleetUrl('/admin/cars'),
      updated_in_fleet: erpDatetime(c.updatedAt, ctx.tz),
    },
  }));
}

async function bookings(ctx: Context, costed: Map<string, CostedTrip>): Promise<Rec[]> {
  const rows = await prisma.booking.findMany({
    orderBy: { startAt: 'asc' },
    include: {
      owner: { select: { name: true, email: true } },
      createdBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
      driver: { select: { name: true } },
      car: { select: { registration: true } },
      reason: { select: { label: true } },
      passengers: { include: { user: { select: { name: true } } } },
      stops: { orderBy: { seq: 'asc' }, include: { reason: true, property: { select: { crmRef: true, address: true } } } },
      trip: true,
    },
  });
  return rows.map((b) => {
    const t = b.trip;
    const c = costed.get(b.id);
    const stopCost = new Map((c?.cost.stops ?? []).map((s) => [s.stopId, s]));
    const listing = (ref: string | null | undefined) => {
      const n = crmListingRef(ref);
      return n && ctx.crmListings.has(n) ? n : null;
    };
    const lead = (ref: string | null) => {
      const n = crmLeadRef(ref);
      return n && ctx.crmLeads.has(n) ? n : null;
    };
    return {
      fleetId: b.id,
      name: bookingRef(b.id),
      doc: {
        fleet_ref: bookingRef(b.id),
        title: `${b.owner.name} · ${b.car.registration} · ${when(b.startAt, ctx.tz)}`,
        status: schema.label(b.status),
        starts_at: erpDatetime(b.startAt, ctx.tz),
        returns_at: erpDatetime(b.expectedReturnAt, ctx.tz),
        booked_by: b.owner.name,
        booked_by_email: b.owner.email,
        passengers: b.passengers.map((p) => p.user.name).join(', ') || null,
        car: carRef(b.carId),
        car_registration: b.car.registration,
        driver: b.driver.name,
        reason: b.reason?.label ?? null,
        urgent: check(b.urgent),
        planned_km: b.plannedDistanceKm,
        planned_minutes: b.plannedDurationMin,
        booked_for_them_by: b.createdById && b.createdById !== b.ownerId ? (b.createdBy?.name ?? null) : null,
        decided_by: b.decidedBy?.name ?? null,
        decided_at: erpDatetime(b.decidedAt, ctx.tz),
        rejection_reason: b.rejectionReason,
        cancelled_at: erpDatetime(b.cancelledAt, ctx.tz),
        cancel_reason: b.cancelReason,
        notes: b.notes,
        stops: b.stops.map((s) => {
          const sc = stopCost.get(s.id);
          return {
            seq: s.seq,
            place: s.label ?? s.property?.address ?? s.address,
            listing: listing(s.property?.crmRef),
            lead: lead(s.crmLeadRef),
            lead_name: s.crmLeadName,
            reason: s.reason.label,
            counts_as_viewing: check(s.reason.countsAsViewing),
            status: schema.label(s.status),
            arrived_at: erpDatetime(s.arrivedAt, ctx.tz),
            departed_at: erpDatetime(s.departedAt, ctx.tz),
            dwell_hours: sc ? Math.round(sc.dwellHours * 100) / 100 : null,
            stop_cost: money(sc?.totalCost),
          };
        }),
        trip_started_at: erpDatetime(t?.startedAt, ctx.tz),
        trip_ended_at: erpDatetime(t?.endedAt, ctx.tz),
        end_method: schema.label(t?.endMethod),
        tracking_status: schema.label(t?.trackingStatus),
        odometer_start: t?.odometerStart ?? null,
        odometer_end: t?.odometerEnd ?? null,
        trip_km: t && t.odometerEnd != null ? t.odometerEnd - t.odometerStart : null,
        unlogged_km: t?.unloggedKm ?? null,
        gps_km: t?.gpsDistanceKm == null ? null : Math.round(t.gpsDistanceKm * 10) / 10,
        fuel_cost: money(c?.cost.fuelCost),
        time_cost: money(c?.cost.timeCost),
        total_cost: money(c?.cost.totalCost),
        cost_per_km: c && c.cost.km > 0 ? money(c.cost.fuelCost / c.cost.km) : null,
        cost_note: c
          ? `Shared stops split ${ctx.split === 'DWELL_TIME' ? 'by time at each stop' : 'equally'} (provisional).` +
            (c.cost.missingFuelPrice ? ' No fuel price for this car and month yet.' : '') +
            (c.cost.missingRateUserIds.length || c.cost.missingDriverRate ? ' Some hourly rates are missing.' : '')
          : null,
        fleet_url: fleetUrl(t ? `/admin/trips/${t.id}` : `/bookings/${b.id}`),
        updated_in_fleet: erpDatetime(t && t.updatedAt > b.updatedAt ? t.updatedAt : b.updatedAt, ctx.tz),
      },
    };
  });
}

async function fuelEntries(ctx: Context): Promise<Rec[]> {
  const rows = await prisma.fuelEntry.findMany({
    orderBy: { date: 'asc' },
    include: { car: { select: { registration: true } }, enteredBy: { select: { name: true } } },
  });
  return rows.map((e) => ({
    fleetId: e.id,
    name: fuelRef(e.id),
    doc: {
      fleet_ref: fuelRef(e.id),
      car: carRef(e.carId),
      car_registration: e.car.registration,
      date: erpDate(e.date, ctx.tz),
      entry_type: schema.label(e.type),
      litres: num(e.litres),
      amount: money(num(e.amount)),
      odometer: e.odometer,
      entered_by: e.enteredBy.name,
      notes: e.notes,
      fleet_url: fleetUrl('/admin/fuel'),
      updated_in_fleet: erpDatetime(e.updatedAt, ctx.tz),
    },
  }));
}

function carMonths(stats: CarMonthStats[], registrations: Map<string, string>): Rec[] {
  const round = (n: number | null, dp: number) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);
  return stats
    .filter((m) => m.km > 0 || m.litres > 0 || m.fuelCost > 0)
    .map((m) => ({
      fleetId: `${m.carId}:${m.month}`,
      name: carMonthRef(m.carId, m.month),
      doc: {
        fleet_ref: carMonthRef(m.carId, m.month),
        car: carRef(m.carId),
        car_registration: registrations.get(m.carId) ?? null,
        month: m.month,
        km: round(m.km, 1),
        trip_km: round(m.tripKm, 1),
        unlogged_km: round(m.unloggedKm, 1),
        litres: round(m.litres, 2),
        fuel_cost: money(m.fuelCost),
        km_per_litre: round(m.kmPerL, 2),
        litres_per_100km: round(m.lPer100Km, 2),
        cost_per_km: money(m.costPerKm),
        rolling_km_per_litre: round(m.rolling.kmPerL, 2),
        rolling_cost_per_km: money(m.rolling.costPerKm),
        fleet_url: fleetUrl('/admin/reports'),
      },
    }));
}

/** Every record, per doctype, in the order ERPNext needs them. */
async function buildRecords(client: ErpClient): Promise<Map<string, Rec[]>> {
  const s = await getSettings();
  // The CRM's copy may be missing (404) or unreadable (403): then stops just don't link.
  // Anything else, such as ERPNext being down, stops the run rather than stripping links.
  const crmNames = (doctype: string) =>
    client.names(doctype).catch((err) => {
      if (err instanceof ErpError && (err.status === 404 || err.status === 403)) return new Set<string>();
      throw err;
    });
  const [crmListings, crmLeads] = await Promise.all([crmNames(schema.CRM_LISTING), crmNames(schema.CRM_LEAD)]);
  const ctx: Context = { tz: s.timezone, split: s.stopCostSplit, crmListings, crmLeads };

  // Costs over the whole history, exactly as the reports work them out.
  const [firstBooking, firstFuel] = await Promise.all([
    prisma.booking.findFirst({ orderBy: { startAt: 'asc' }, select: { startAt: true } }),
    prisma.fuelEntry.findFirst({ orderBy: { date: 'asc' }, select: { date: true } }),
  ]);
  const to = new Date(Date.now() + 24 * 3600_000);
  const from = new Date(Math.min(firstBooking?.startAt.getTime() ?? to.getTime(), firstFuel?.date.getTime() ?? to.getTime()));
  const ds = await loadDataset(from, to);
  const { trips, carMonths: stats } = costedTripsAndCarMonths(ds, { from, to });
  const costed = new Map(trips.map((t) => [t.booking.id, t]));
  const carRecs = await cars(ctx);
  const registrations = new Map(carRecs.map((r) => [r.fleetId, r.doc.registration as string]));

  const records = new Map<string, Rec[]>([
    [schema.CAR, carRecs],
    [schema.BOOKING, await bookings(ctx, costed)],
    [schema.FUEL, await fuelEntries(ctx)],
    [schema.CAR_MONTH, carMonths(stats, registrations)],
  ]);
  for (const [doctype, recs] of records) records.set(doctype, recs.map((r) => ({ ...r, doc: fit(doctype, r.doc) })));
  return records;
}

export const DOCTYPES = [schema.CAR, schema.BOOKING, schema.FUEL, schema.CAR_MONTH] as const;
/** Short names for the command line. */
export const KINDS: Record<string, string> = { cars: schema.CAR, bookings: schema.BOOKING, fuel: schema.FUEL, 'car-months': schema.CAR_MONTH };

// -- the run ---------------------------------------------------------------------------------

export interface SyncReport {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  failed: number;
  errors: string[];
}
const emptyReport = (): SyncReport => ({ created: 0, updated: 0, unchanged: 0, deleted: 0, failed: 0, errors: [] });
export const summary = (r: SyncReport) =>
  `${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.deleted} deleted, ${r.failed} failed` +
  r.errors.slice(0, 20).map((e) => `\n  ${e}`).join('');

/** One pass: send what changed, delete what Fleet no longer has. */
export async function syncToErp(
  client: ErpClient,
  opts: { doctypes?: string[]; dryRun?: boolean; force?: boolean; now?: Date } = {},
): Promise<SyncReport> {
  const report = emptyReport();
  const now = opts.now ?? new Date();
  const wanted = DOCTYPES.filter((d) => !opts.doctypes || opts.doctypes.includes(d));
  const records = await buildRecords(client);
  const toDelete: { doctype: string; id: string; name: string }[] = [];

  for (const doctype of wanted) {
    const states = new Map((await prisma.erpSyncState.findMany({ where: { doctype } })).map((s) => [s.fleetId, s]));
    const seen = new Set<string>();
    const names = new Map<string, string>();
    for (const rec of records.get(doctype) ?? []) {
      seen.add(rec.fleetId);
      const clash = names.get(rec.name);
      names.set(rec.name, rec.fleetId);
      const digest = payloadHash(rec.doc);
      const state = states.get(rec.fleetId);
      const same = state && !opts.force && state.payloadHash === digest;
      if (same && !state.lastError) {
        report.unchanged++;
        continue;
      }
      if (same && state.failedAt && now.getTime() - state.failedAt.getTime() < RETRY_FAILED_AFTER_MS) {
        report.failed++; // failed recently and nothing changed since: wait
        continue;
      }
      if (opts.dryRun) {
        state ? report.updated++ : report.created++;
        continue;
      }
      let error: string | null = null;
      if (clash) error = `${rec.name} is also the name of ${clash}; refusing to overwrite it`;
      else {
        try {
          const outcome = await client.upsert(doctype, rec.name, rec.doc, Boolean(state?.syncedAt));
          outcome === 'created' ? report.created++ : report.updated++;
        } catch (err) {
          if (!(err instanceof ErpError)) throw err;
          error = err.message;
        }
      }
      if (error) {
        report.failed++;
        report.errors.push(`${doctype} ${rec.name}: ${error}`);
        console.warn(`[erp.sync] ${doctype} ${rec.name} failed: ${error}`);
      }
      const values = error
        ? { erpName: rec.name, payloadHash: digest, lastError: error.slice(0, 2000), failedAt: now }
        : { erpName: rec.name, payloadHash: digest, syncedAt: now, lastError: null, failedAt: null };
      await prisma.erpSyncState.upsert({
        where: { doctype_fleetId: { doctype, fleetId: rec.fleetId } },
        create: { doctype, fleetId: rec.fleetId, ...values },
        update: values,
      });
    }
    for (const [id, s] of states) if (!seen.has(id)) toDelete.push({ doctype, id, name: s.erpName });
  }

  for (const doctype of [...wanted].reverse()) {
    for (const d of toDelete.filter((x) => x.doctype === doctype)) {
      if (opts.dryRun) {
        report.deleted++;
        continue;
      }
      try {
        await client.delete(doctype, d.name);
      } catch (err) {
        if (!(err instanceof ErpError)) throw err;
        report.failed++;
        report.errors.push(`${doctype} ${d.name} (delete): ${err.message}`);
        continue;
      }
      await prisma.erpSyncState.delete({ where: { doctype_fleetId: { doctype, fleetId: d.id } } });
      report.deleted++;
    }
  }
  return report;
}

/**
 * Check ERPNext against Fleet and repair drift, then run a normal pass: anything deleted in
 * ERPNext by hand is sent again; anything named like ours that Fleet doesn't have is removed.
 */
export async function reconcileErp(client: ErpClient, opts: { dryRun?: boolean } = {}): Promise<SyncReport> {
  const records = await buildRecords(client);
  const report = emptyReport();
  const strays: { doctype: string; name: string }[] = [];
  for (const doctype of DOCTYPES) {
    const present = await client.names(doctype);
    const expected = new Set((records.get(doctype) ?? []).map((r) => r.name));
    if (!opts.dryRun) {
      const states = await prisma.erpSyncState.findMany({ where: { doctype } });
      const missing = states.filter((s) => !present.has(s.erpName)).map((s) => s.id);
      if (missing.length) await prisma.erpSyncState.updateMany({ where: { id: { in: missing } }, data: { payloadHash: null } });
    }
    for (const name of present) if (!expected.has(name) && name.startsWith(STRAY_PREFIXES[doctype]!)) strays.push({ doctype, name });
  }
  for (const doctype of [...DOCTYPES].reverse()) {
    for (const s of strays.filter((x) => x.doctype === doctype)) {
      if (opts.dryRun) {
        report.deleted++;
        continue;
      }
      try {
        await client.delete(doctype, s.name);
        report.deleted++;
      } catch (err) {
        if (!(err instanceof ErpError)) throw err;
        report.failed++;
        report.errors.push(`${doctype} ${s.name} (delete): ${err.message}`);
      }
    }
  }
  const pass = await syncToErp(client, { dryRun: opts.dryRun });
  return {
    created: pass.created,
    updated: pass.updated,
    unchanged: pass.unchanged,
    deleted: report.deleted + pass.deleted,
    failed: report.failed + pass.failed,
    errors: [...report.errors, ...pass.errors],
  };
}

// -- health: ERPNext's status card and Fleet's admin warning ----------------------------------

export interface ErpSyncHealth {
  ranAt: string;
  error: string | null;
  sent: number;
  failingRecords: number;
  firstFailure: string | null;
  lastSuccessAt: string | null;
}

async function failing(): Promise<{ count: number; first: string | null }> {
  const [count, newest] = await Promise.all([
    prisma.erpSyncState.count({ where: { lastError: { not: null } } }),
    prisma.erpSyncState.findFirst({ where: { lastError: { not: null } }, orderBy: { failedAt: 'desc' } }),
  ]);
  return { count, first: newest ? `${newest.erpName}: ${newest.lastError}` : null };
}

/** Record how the last run went. `error` means the run as a whole failed. */
export async function saveErpHealth(opts: { error?: string | null; report?: SyncReport; now?: Date } = {}): Promise<ErpSyncHealth> {
  const now = opts.now ?? new Date();
  const previous = (await prisma.setting.findUnique({ where: { key: HEALTH_KEY } }))?.value as ErpSyncHealth | undefined;
  const f = await failing();
  const r = opts.report;
  const health: ErpSyncHealth = {
    ranAt: now.toISOString(),
    error: opts.error ?? null,
    sent: r ? r.created + r.updated + r.deleted : 0,
    failingRecords: f.count,
    firstFailure: f.first,
    lastSuccessAt: opts.error ? (previous?.lastSuccessAt ?? null) : now.toISOString(),
  };
  const value = health as unknown as object;
  await prisma.setting.upsert({ where: { key: HEALTH_KEY }, create: { key: HEALTH_KEY, value }, update: { value } });
  return health;
}

/**
 * One scheduled pass (or a reconcile), then tell ERPNext and Fleet how it went. The status
 * record is written every time, even when nothing changed, so it doubles as a check that
 * ERPNext can be reached: a quiet ERPNext otherwise looks the same as a sync that has stopped.
 */
export async function runErpSync(client: ErpClient, opts: { full?: boolean; doctypes?: string[]; force?: boolean } = {}): Promise<SyncReport> {
  let report: SyncReport | undefined;
  try {
    report = opts.full ? await reconcileErp(client) : await syncToErp(client, { doctypes: opts.doctypes, force: opts.force });
    const s = await getSettings();
    const f = await failing();
    const status = {
      synced_at: erpDatetime(new Date(), s.timezone),
      sent: report.created + report.updated + report.deleted,
      failing_records: f.count,
      first_failure: f.first ? f.first.slice(0, 1000) : null,
      interval_minutes: INTERVAL_MINUTES,
      fleet_url: fleetUrl('/admin/approvals'),
    };
    await client.upsert(schema.SYNC_STATUS, schema.SYNC_STATUS, fit(schema.SYNC_STATUS, status), true);
  } catch (err) {
    if (err instanceof ErpError) await saveErpHealth({ error: `couldn’t reach ERPNext: ${err.message}`, report });
    throw err;
  }
  await saveErpHealth({ report });
  return report;
}

/** A sentence for the admin banner when the ERPNext copy isn't keeping up, else null. */
export async function erpSyncWarning(now = new Date()): Promise<string | null> {
  if (!env.ERP_SYNC_ENABLED) return null;
  const health = (await prisma.setting.findUnique({ where: { key: HEALTH_KEY } }))?.value as ErpSyncHealth | undefined;
  if (!health) return 'The copy to ERPNext is switched on but hasn’t run yet. Restart the worker.';
  const tz = (await getSettings()).timezone;
  const at = (iso: string) => when(new Date(iso), tz);
  if (now.getTime() - new Date(health.ranAt).getTime() > STALE_AFTER_MS) {
    return `The copy to ERPNext hasn’t run since ${at(health.ranAt)}. The worker may have stopped, so ERPNext is out of date.`;
  }
  if (health.error) {
    return `The copy to ERPNext is failing (${health.error.slice(0, 200)}).${health.lastSuccessAt ? ` Last good copy: ${at(health.lastSuccessAt)}.` : ''}`;
  }
  if (health.failingRecords) {
    const n = health.failingRecords;
    return `${n} record${n === 1 ? '' : 's'} couldn’t be copied to ERPNext, for example ${(health.firstFailure ?? '').slice(0, 200)}.`;
  }
  return null;
}
