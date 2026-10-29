import { carMonthlyStats, computeTripCost, costPerKmLookup, type FuelEntryLite, type HourlyRateLite, type KmRecord, type TripCost } from './costs';
import { DEPARTMENT_LABELS, type BookingStatus, type DealType, type Department, type PropertyService, type PropertyStatus, type StopStatus, type TrackingEventType } from './enums';
import type { Settings } from './settings';
import { addMonths, DAY, HOUR, monthKey, monthRange, workingMinutesBetween } from './time';
import { odometerVariancePct } from './trip';

// ── Dataset ───────────────────────────────────────────────────────────────────

export interface RDUser {
  id: string;
  name: string;
  department: Department | null;
  jobRoleId: string | null;
}
export interface RDCar {
  id: string;
  label: string;
}
export interface RDDriver {
  id: string;
  name: string;
}
export interface RDReason {
  id: string;
  label: string;
  department: Department;
  countsAsViewing: boolean;
}
export interface RDProperty {
  id: string;
  ref: string;
  address: string;
  clientId: string | null;
  service: PropertyService;
  status: PropertyStatus;
}
export interface RDClient {
  id: string;
  name: string;
}
export interface RDStop {
  id: string;
  seq: number;
  addedById: string;
  reasonId: string;
  propertyId: string | null;
  status: StopStatus;
  arrivedAt: Date | null;
  departedAt: Date | null;
}
export interface RDTrip {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  odometerStart: number;
  odometerEnd: number | null;
  gpsDistanceKm: number | null;
  unloggedKm: number;
  events: { type: TrackingEventType; occurredAt: Date }[];
}
export interface RDBooking {
  id: string;
  ownerId: string;
  carId: string;
  driverId: string;
  status: BookingStatus;
  startAt: Date;
  expectedReturnAt: Date;
  passengerIds: string[];
  stops: RDStop[];
  trip: RDTrip | null;
}
export interface RDClosure {
  id: string;
  propertyId: string;
  staffId: string | null;
  closedAt: Date;
  dealType: DealType;
  fee: number | null;
}

export interface ReportDataset {
  tz: string;
  settings: Pick<
    Settings,
    'workingHours' | 'odometerVarianceThresholdPct' | 'stopCostSplit' | 'manyViewingsThreshold' | 'currency'
  >;
  cars: RDCar[];
  drivers: RDDriver[];
  users: RDUser[];
  reasons: RDReason[];
  properties: RDProperty[];
  clients: RDClient[];
  /**
   * Bookings starting from two months before `from` (so rolling fuel figures are
   * complete) up to `to`.
   */
  bookings: RDBooking[];
  /** Fuel entries from two months before `from` up to `to`. */
  fuelEntries: FuelEntryLite[];
  rates: HourlyRateLite[];
  closures: RDClosure[];
  /** Earliest viewing of each property, ever (for days from first viewing to closure). */
  firstViewingAt: Record<string, Date>;
}

export interface ReportFilters {
  from: Date;
  to: Date;
  carId?: string;
  staffId?: string;
  department?: Department;
  reasonId?: string;
  propertyId?: string;
  clientId?: string;
}

export const REPORT_IDS = [
  'fuel-efficiency',
  'cost-per-km',
  'usage',
  'cost-allocation',
  'compliance',
  'cost-per-viewing',
  'property-client-cost',
  'staff-effectiveness',
] as const;
export type ReportId = (typeof REPORT_IDS)[number];

export type ColumnType = 'text' | 'int' | 'number' | 'money' | 'km' | 'percent' | 'hours' | 'date' | 'month';
export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}
export type ReportCell = string | number | null;
export interface ReportResult {
  id: ReportId;
  title: string;
  description: string;
  columns: ReportColumn[];
  rows: Record<string, ReportCell>[];
  notes: string[];
  chart?: { x: string; y: string; seriesBy: string; label: string };
}

export const REPORT_META: Record<ReportId, { title: string; description: string; options?: Record<string, string[]> }> = {
  'fuel-efficiency': {
    title: 'Fuel efficiency by car',
    description: 'km per litre and L/100 km by month, with a rolling 3-month average.',
  },
  'cost-per-km': {
    title: 'Cost per km and fuel cost',
    description: 'Fuel cost, km driven and cost per km by car and month.',
  },
  usage: {
    title: 'Usage',
    description: 'Trips, km, hours out and utilisation % (booked hours ÷ working hours).',
    options: { groupBy: ['car', 'driver', 'staff', 'department', 'reason'] },
  },
  'cost-allocation': {
    title: 'Cost allocation',
    description: 'Fuel and time cost allocated to departments, visit reasons and staff.',
    options: { groupBy: ['department', 'reason', 'staff'] },
  },
  compliance: {
    title: 'Compliance',
    description: 'Unlogged km, odometer vs GPS variance, tracking interruptions, overdue returns, no-shows, rejections and cancellations.',
  },
  'cost-per-viewing': {
    title: 'Cost per viewing',
    description: 'Fuel and time for each viewing, or averaged by property, service or staff member.',
    options: { groupBy: ['viewing', 'property', 'service', 'staff'] },
  },
  'property-client-cost': {
    title: 'Property and client cost',
    description: 'Visits, hours, km and cost per property or client, set against closures and fees.',
    options: { groupBy: ['property', 'client'] },
  },
  'staff-effectiveness': {
    title: 'Staff effectiveness',
    description: 'Viewings, closures, viewings per closure, cost per closure and days from first viewing to closure, ranked.',
  },
};

const SERVICE_LABELS: Record<PropertyService, string> = { SALES: 'Sales', LETTINGS: 'Lettings', MANAGEMENT: 'Management' };

// ── Shared derivations ────────────────────────────────────────────────────────

const STOPS_THAT_HAPPENED: StopStatus[] = ['PLANNED', 'ARRIVED', 'DEPARTED'];
const RAN: BookingStatus[] = ['IN_PROGRESS', 'COMPLETED', 'AWAITING_ODOMETER'];

const inRange = (d: Date, f: ReportFilters) => d >= f.from && d < f.to;

export interface CostedStop {
  stop: RDStop;
  booking: RDBooking;
  cost: TripCost['stops'][number];
  reason: RDReason | undefined;
  property: RDProperty | undefined;
  at: Date;
}

export interface CostedTrip {
  booking: RDBooking;
  trip: RDTrip;
  cost: TripCost;
  stops: CostedStop[];
}

interface Context {
  ds: ReportDataset;
  f: ReportFilters;
  users: Map<string, RDUser>;
  reasons: Map<string, RDReason>;
  properties: Map<string, RDProperty>;
  clients: Map<string, RDClient>;
  cars: Map<string, RDCar>;
  drivers: Map<string, RDDriver>;
  costed: CostedTrip[];
  months: string[];
}

function buildContext(ds: ReportDataset, f: ReportFilters): Context {
  const users = new Map(ds.users.map((u) => [u.id, u]));
  const reasons = new Map(ds.reasons.map((r) => [r.id, r]));
  const properties = new Map(ds.properties.map((p) => [p.id, p]));
  const clients = new Map(ds.clients.map((c) => [c.id, c]));
  const cars = new Map(ds.cars.map((c) => [c.id, c]));
  const drivers = new Map(ds.drivers.map((d) => [d.id, d]));
  const months = monthRange(monthKey(f.from, ds.tz), monthKey(new Date(f.to.getTime() - 1), ds.tz));

  // Cost per km comes from every car's full data, before any filter is applied.
  const stats = carMonthlyStats({
    carIds: ds.cars.map((c) => c.id),
    months: monthRange(addMonths(months[0]!, -2), months[months.length - 1]!),
    fuelEntries: ds.fuelEntries,
    kmRecords: kmRecords(ds.bookings),
    tz: ds.tz,
  });
  const cpk = costPerKmLookup(stats);

  const costed: CostedTrip[] = [];
  for (const b of ds.bookings) {
    const t = b.trip;
    if (!t || !t.endedAt || t.odometerEnd == null || !inRange(t.startedAt, f)) continue;
    const happened = b.stops.filter((s) => STOPS_THAT_HAPPENED.includes(s.status)).sort((a, z) => a.seq - z.seq);
    const people = [b.ownerId, ...b.passengerIds.filter((p) => p !== b.ownerId)].map((id) => ({
      userId: id,
      jobRoleId: users.get(id)?.jobRoleId ?? null,
    }));
    const cost = computeTripCost(
      {
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        km: t.odometerEnd - t.odometerStart,
        costPerKm: cpk(b.carId, monthKey(t.startedAt, ds.tz)),
        people,
        driverCount: 1,
        stops: happened,
      },
      ds.rates,
      ds.settings.stopCostSplit,
    );
    costed.push({
      booking: b,
      trip: t,
      cost,
      stops: happened.map((s, i) => ({
        stop: s,
        booking: b,
        cost: cost.stops[i]!,
        reason: reasons.get(s.reasonId),
        property: s.propertyId ? properties.get(s.propertyId) : undefined,
        at: s.arrivedAt ?? t.startedAt,
      })),
    });
  }
  return { ds, f, users, reasons, properties, clients, cars, drivers, costed, months };
}

function kmRecords(bookings: RDBooking[]): KmRecord[] {
  const out: KmRecord[] = [];
  for (const b of bookings) {
    const t = b.trip;
    if (!t) continue;
    if (t.odometerEnd != null) out.push({ carId: b.carId, at: t.startedAt, km: t.odometerEnd - t.odometerStart, kind: 'TRIP' });
    if (t.unloggedKm > 0) out.push({ carId: b.carId, at: t.startedAt, km: t.unloggedKm, kind: 'UNLOGGED' });
  }
  return out;
}

function stopMatches(cs: CostedStop, ctx: Context): boolean {
  const { f } = ctx;
  if (f.staffId && cs.stop.addedById !== f.staffId) return false;
  if (f.reasonId && cs.stop.reasonId !== f.reasonId) return false;
  if (f.department && cs.reason?.department !== f.department) return false;
  if (f.propertyId && cs.stop.propertyId !== f.propertyId) return false;
  if (f.clientId && cs.property?.clientId !== f.clientId) return false;
  return true;
}

function hasStopFilter(f: ReportFilters) {
  return Boolean(f.reasonId || f.department || f.propertyId || f.clientId);
}

function bookingMatches(b: RDBooking, ctx: Context): boolean {
  const { f } = ctx;
  if (f.carId && b.carId !== f.carId) return false;
  if (f.staffId && b.ownerId !== f.staffId && !b.passengerIds.includes(f.staffId) && !b.stops.some((s) => s.addedById === f.staffId)) {
    return false;
  }
  if (hasStopFilter(f)) {
    return b.stops.some((s) => {
      const reason = ctx.reasons.get(s.reasonId);
      const property = s.propertyId ? ctx.properties.get(s.propertyId) : undefined;
      if (f.reasonId && s.reasonId !== f.reasonId) return false;
      if (f.department && reason?.department !== f.department) return false;
      if (f.propertyId && s.propertyId !== f.propertyId) return false;
      if (f.clientId && property?.clientId !== f.clientId) return false;
      return true;
    });
  }
  return true;
}

/** Costed stops passing every filter. */
function filteredStops(ctx: Context): CostedStop[] {
  return ctx.costed
    .filter((ct) => !ctx.f.carId || ct.booking.carId === ctx.f.carId)
    .flatMap((ct) => ct.stops)
    .filter((cs) => stopMatches(cs, ctx));
}

const userName = (ctx: Context, id: string | null | undefined) => (id ? ctx.users.get(id)?.name ?? 'Unknown' : 'Unknown');
const round = (n: number | null, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

function costNotes(ctx: Context, stops?: CostedStop[]): string[] {
  const trips = stops ? new Set(stops.map((s) => s.booking.id)) : null;
  const relevant = ctx.costed.filter((c) => !trips || trips.has(c.booking.id));
  const notes: string[] = [];
  const noFuel = relevant.filter((c) => c.cost.missingFuelPrice).length;
  if (noFuel) notes.push(`${noFuel} trip(s) have no fuel price for their month, so their fuel cost is 0. Add fuel entries for those cars.`);
  const missingPeople = new Set(relevant.flatMap((c) => c.cost.missingRateUserIds));
  if (missingPeople.size) {
    notes.push(
      `No hourly rate for ${[...missingPeople].map((id) => userName(ctx, id)).join(', ')}. Set their job role and its rate; their time is costed at 0.`,
    );
  }
  if (relevant.some((c) => c.cost.missingDriverRate)) notes.push('No driver hourly rate is set; driver time is costed at 0.');
  if (relevant.length) {
    notes.push(
      ctx.ds.settings.stopCostSplit === 'EQUAL'
        ? 'Provisional: each trip\'s fuel and travel time are split equally across its stops until the business confirms the sharing formula.'
        : 'Provisional: each trip\'s fuel and travel time are split by time spent at each stop until the business confirms the sharing formula.',
    );
  }
  return notes;
}

// ── 1 & 2. Fuel efficiency and cost per km ────────────────────────────────────

function monthlyRows(ctx: Context) {
  const stats = carMonthlyStats({
    carIds: ctx.ds.cars.filter((c) => !ctx.f.carId || c.id === ctx.f.carId).map((c) => c.id),
    months: ctx.months,
    fuelEntries: ctx.ds.fuelEntries,
    kmRecords: kmRecords(ctx.ds.bookings),
    tz: ctx.ds.tz,
  });
  return stats.map((s) => ({ s, car: ctx.cars.get(s.carId)?.label ?? s.carId }));
}

function fuelEfficiency(ctx: Context): ReportResult {
  const rows = monthlyRows(ctx).map(({ s, car }) => ({
    car,
    month: s.month,
    tripKm: round(s.tripKm, 0),
    unloggedKm: round(s.unloggedKm, 0),
    km: round(s.km, 0),
    litres: round(s.litres),
    kmPerL: round(s.kmPerL),
    lPer100Km: round(s.lPer100Km),
    rollingKmPerL: round(s.rolling.kmPerL),
    rollingLPer100Km: round(s.rolling.lPer100Km),
  }));
  const notes = ['A monthly fill-up rarely matches that month\'s driving, so use the rolling 3-month figure for trends.'];
  if (rows.some((r) => r.km && !r.litres)) notes.push('Months with km but no litres have no efficiency figure. Check fuel entries.');
  return {
    ...meta('fuel-efficiency'),
    columns: [
      { key: 'car', label: 'Car', type: 'text' },
      { key: 'month', label: 'Month', type: 'month' },
      { key: 'tripKm', label: 'Trip km', type: 'km' },
      { key: 'unloggedKm', label: 'Unlogged km', type: 'km' },
      { key: 'km', label: 'Total km', type: 'km' },
      { key: 'litres', label: 'Litres', type: 'number' },
      { key: 'kmPerL', label: 'km/L', type: 'number' },
      { key: 'lPer100Km', label: 'L/100 km', type: 'number' },
      { key: 'rollingKmPerL', label: 'km/L (3-mo)', type: 'number' },
      { key: 'rollingLPer100Km', label: 'L/100 km (3-mo)', type: 'number' },
    ],
    rows,
    notes,
    chart: { x: 'month', y: 'rollingKmPerL', seriesBy: 'car', label: 'km/L (rolling 3 months)' },
  };
}

function costPerKm(ctx: Context): ReportResult {
  const rows = monthlyRows(ctx).map(({ s, car }) => ({
    car,
    month: s.month,
    km: round(s.km, 0),
    fuelCost: round(s.fuelCost),
    costPerKm: round(s.costPerKm),
    rollingCostPerKm: round(s.rolling.costPerKm),
  }));
  const totalCost = rows.reduce((a, r) => a + (r.fuelCost ?? 0), 0);
  const totalKm = rows.reduce((a, r) => a + (r.km ?? 0), 0);
  return {
    ...meta('cost-per-km'),
    columns: [
      { key: 'car', label: 'Car', type: 'text' },
      { key: 'month', label: 'Month', type: 'month' },
      { key: 'km', label: 'km', type: 'km' },
      { key: 'fuelCost', label: 'Fuel cost', type: 'money' },
      { key: 'costPerKm', label: 'Cost per km', type: 'money' },
      { key: 'rollingCostPerKm', label: 'Cost per km (3-mo)', type: 'money' },
    ],
    rows,
    notes: [`Total fuel cost ${round(totalCost)} ${ctx.ds.settings.currency} over ${round(totalKm, 0)} km${totalKm ? ` (${round(totalCost / totalKm)} per km)` : ''}.`],
    chart: { x: 'month', y: 'costPerKm', seriesBy: 'car', label: `Cost per km (${ctx.ds.settings.currency})` },
  };
}

// ── 3. Usage ──────────────────────────────────────────────────────────────────

function usage(ctx: Context, groupBy: string): ReportResult {
  const { ds, f } = ctx;
  const workingMin = workingMinutesBetween(f.from, f.to, ds.settings.workingHours, ds.tz);
  const ran = ds.bookings.filter((b) => RAN.includes(b.status) && b.trip && inRange(b.trip.startedAt, f) && bookingMatches(b, ctx));

  interface Acc {
    name: string;
    trips: Set<string>;
    km: number;
    hoursOut: number;
    bookedHours: number;
    bookedWorkingMin: number;
  }
  const groups = new Map<string, Acc>();
  const acc = (key: string, name: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { name, trips: new Set(), km: 0, hoursOut: 0, bookedHours: 0, bookedWorkingMin: 0 };
      groups.set(key, g);
    }
    return g;
  };

  for (const b of ran) {
    const t = b.trip!;
    const km = t.odometerEnd != null ? t.odometerEnd - t.odometerStart : 0;
    const hoursOut = ((t.endedAt ?? new Date(Math.min(Date.now(), f.to.getTime()))).getTime() - t.startedAt.getTime()) / HOUR;
    const bookedHours = (b.expectedReturnAt.getTime() - b.startAt.getTime()) / HOUR;
    const bookedWorkingMin = workingMinutesBetween(b.startAt, b.expectedReturnAt, ds.settings.workingHours, ds.tz);

    // Whole-trip dimensions.
    if (groupBy === 'car' || groupBy === 'driver') {
      const key = groupBy === 'car' ? b.carId : b.driverId;
      const name = groupBy === 'car' ? ctx.cars.get(key)?.label ?? key : ctx.drivers.get(key)?.name ?? key;
      const g = acc(key, name);
      g.trips.add(b.id);
      g.km += km;
      g.hoursOut += hoursOut;
      g.bookedHours += bookedHours;
      g.bookedWorkingMin += bookedWorkingMin;
      continue;
    }

    // Stop-level dimensions: the trip is shared across its stops.
    const stops = b.stops.filter((s) => STOPS_THAT_HAPPENED.includes(s.status));
    if (stops.length === 0) continue;
    const share = 1 / stops.length;
    for (const s of stops) {
      const reason = ctx.reasons.get(s.reasonId);
      let key: string;
      let name: string;
      if (groupBy === 'staff') {
        key = s.addedById;
        name = userName(ctx, key);
      } else if (groupBy === 'department') {
        key = reason?.department ?? 'OTHER';
        name = DEPARTMENT_LABELS[key as Department] ?? key;
      } else {
        key = s.reasonId;
        name = reason?.label ?? 'Unknown reason';
      }
      const g = acc(key, name);
      g.trips.add(b.id);
      g.km += km * share;
      g.hoursOut += hoursOut * share;
      g.bookedHours += bookedHours * share;
      g.bookedWorkingMin += bookedWorkingMin * share;
    }
  }

  const rows = [...groups.values()]
    .map((g) => ({
      name: g.name,
      trips: g.trips.size,
      km: round(g.km, 1),
      hoursOut: round(g.hoursOut, 1),
      bookedHours: round(g.bookedHours, 1),
      utilisationPct: round(workingMin > 0 ? (g.bookedWorkingMin / workingMin) * 100 : null, 1),
    }))
    .sort((a, z) => (z.bookedHours ?? 0) - (a.bookedHours ?? 0));

  // Cars with no trips still matter for utilisation.
  if (groupBy === 'car') {
    for (const car of ds.cars) {
      if (f.carId && car.id !== f.carId) continue;
      if (!groups.has(car.id)) rows.push({ name: car.label, trips: 0, km: 0, hoursOut: 0, bookedHours: 0, utilisationPct: 0 });
    }
  }

  return {
    ...meta('usage'),
    columns: [
      { key: 'name', label: groupLabel(groupBy), type: 'text' },
      { key: 'trips', label: 'Trips', type: 'int' },
      { key: 'km', label: 'km', type: 'km' },
      { key: 'hoursOut', label: 'Hours out', type: 'hours' },
      { key: 'bookedHours', label: 'Booked hours', type: 'hours' },
      { key: 'utilisationPct', label: 'Utilisation', type: 'percent' },
    ],
    rows,
    notes: [
      `Utilisation = booked hours inside working hours ÷ ${round(workingMin / 60, 1)} working hours in the period.`,
      ...(groupBy === 'car' || groupBy === 'driver' ? [] : ['A trip with several stops is shared equally across them for km and hours.']),
    ],
  };
}

function groupLabel(groupBy: string) {
  return (
    { car: 'Car', driver: 'Driver', staff: 'Staff member', department: 'Department', reason: 'Reason', property: 'Property', client: 'Client', service: 'Service', viewing: 'Viewing' }[groupBy] ??
    groupBy
  );
}

// ── 4. Cost allocation ────────────────────────────────────────────────────────

function costAllocation(ctx: Context, groupBy: string): ReportResult {
  const stops = filteredStops(ctx);
  interface Acc {
    name: string;
    stops: number;
    km: number;
    hours: number;
    fuelCost: number;
    timeCost: number;
  }
  const groups = new Map<string, Acc>();
  for (const cs of stops) {
    let key: string;
    let name: string;
    if (groupBy === 'staff') {
      key = cs.stop.addedById;
      name = userName(ctx, key);
    } else if (groupBy === 'reason') {
      key = cs.stop.reasonId;
      name = cs.reason?.label ?? 'Unknown reason';
    } else {
      key = cs.reason?.department ?? 'OTHER';
      name = DEPARTMENT_LABELS[key as Department] ?? key;
    }
    const g = groups.get(key) ?? { name, stops: 0, km: 0, hours: 0, fuelCost: 0, timeCost: 0 };
    g.stops += 1;
    g.km += cs.cost.km;
    g.hours += cs.cost.hours;
    g.fuelCost += cs.cost.fuelCost;
    g.timeCost += cs.cost.timeCost;
    groups.set(key, g);
  }
  const grand = [...groups.values()].reduce((a, g) => a + g.fuelCost + g.timeCost, 0);
  const rows = [...groups.values()]
    .map((g) => ({
      name: g.name,
      stops: g.stops,
      km: round(g.km, 1),
      hours: round(g.hours, 1),
      fuelCost: round(g.fuelCost),
      timeCost: round(g.timeCost),
      totalCost: round(g.fuelCost + g.timeCost),
      sharePct: round(grand > 0 ? ((g.fuelCost + g.timeCost) / grand) * 100 : null, 1),
    }))
    .sort((a, z) => (z.totalCost ?? 0) - (a.totalCost ?? 0));
  return {
    ...meta('cost-allocation'),
    columns: [
      { key: 'name', label: groupLabel(groupBy), type: 'text' },
      { key: 'stops', label: 'Stops', type: 'int' },
      { key: 'km', label: 'km', type: 'km' },
      { key: 'hours', label: 'Hours', type: 'hours' },
      { key: 'fuelCost', label: 'Fuel cost', type: 'money' },
      { key: 'timeCost', label: 'Time cost', type: 'money' },
      { key: 'totalCost', label: 'Total cost', type: 'money' },
      { key: 'sharePct', label: 'Share', type: 'percent' },
    ],
    rows,
    notes: costNotes(ctx, stops),
  };
}

// ── 5. Compliance ─────────────────────────────────────────────────────────────

function compliance(ctx: Context): ReportResult {
  const { ds, f } = ctx;
  interface Acc {
    trips: number;
    unloggedKm: number;
    varianceFlags: number;
    locationOff: number;
    trackingLost: number;
    overdue: number;
    awaitingOdometer: number;
    noShows: number;
    rejected: number;
    cancelled: number;
  }
  const by = new Map<string, Acc>();
  const acc = (id: string) => {
    let a = by.get(id);
    if (!a) {
      a = { trips: 0, unloggedKm: 0, varianceFlags: 0, locationOff: 0, trackingLost: 0, overdue: 0, awaitingOdometer: 0, noShows: 0, rejected: 0, cancelled: 0 };
      by.set(id, a);
    }
    return a;
  };

  for (const b of ds.bookings) {
    if (!bookingMatches(b, ctx)) continue;
    const t = b.trip;
    if (t && inRange(t.startedAt, f)) {
      const a = acc(b.ownerId);
      a.trips += 1;
      a.unloggedKm += t.unloggedKm;
      const odoKm = t.odometerEnd != null ? t.odometerEnd - t.odometerStart : null;
      const v = odometerVariancePct(odoKm, t.gpsDistanceKm);
      if (v != null && v > ds.settings.odometerVarianceThresholdPct) a.varianceFlags += 1;
      a.locationOff += t.events.filter((e) => e.type === 'LOCATION_OFF').length;
      a.trackingLost += t.events.filter((e) => e.type === 'TRACKING_LOST').length;
      if (t.events.some((e) => e.type === 'OVERDUE')) a.overdue += 1;
      if (t.events.some((e) => e.type === 'AWAITING_ODOMETER')) a.awaitingOdometer += 1;
    } else if (inRange(b.startAt, f)) {
      if (b.status === 'NO_SHOW') acc(b.ownerId).noShows += 1;
      else if (b.status === 'REJECTED') acc(b.ownerId).rejected += 1;
      else if (b.status === 'CANCELLED') acc(b.ownerId).cancelled += 1;
    }
  }

  const rows = [...by.entries()]
    .map(([id, a]) => ({ name: userName(ctx, id), ...a }))
    .sort((x, y) => x.name.localeCompare(y.name));
  return {
    ...meta('compliance'),
    columns: [
      { key: 'name', label: 'Staff member', type: 'text' },
      { key: 'trips', label: 'Trips', type: 'int' },
      { key: 'unloggedKm', label: 'Unlogged km found at start', type: 'km' },
      { key: 'varianceFlags', label: 'Odometer vs GPS flags', type: 'int' },
      { key: 'locationOff', label: 'Location off', type: 'int' },
      { key: 'trackingLost', label: 'Tracking lost', type: 'int' },
      { key: 'overdue', label: 'Overdue returns', type: 'int' },
      { key: 'awaitingOdometer', label: 'Odometer not entered', type: 'int' },
      { key: 'noShows', label: 'No-shows', type: 'int' },
      { key: 'rejected', label: 'Rejected', type: 'int' },
      { key: 'cancelled', label: 'Cancelled', type: 'int' },
    ],
    rows,
    notes: [
      'Unlogged km is the gap between the car\'s last end reading and this trip\'s start reading. It is shown against the staff member who found it, not necessarily who drove it.',
      `Odometer vs GPS is flagged when they differ by more than ${ds.settings.odometerVarianceThresholdPct}%.`,
    ],
  };
}

// ── 6. Cost per viewing ───────────────────────────────────────────────────────

function costPerViewing(ctx: Context, groupBy: string): ReportResult {
  const viewings = filteredStops(ctx).filter((cs) => cs.reason?.countsAsViewing);
  const notes = costNotes(ctx, viewings);

  if (groupBy === 'viewing') {
    const rows = viewings
      .sort((a, z) => a.at.getTime() - z.at.getTime())
      .map((cs) => ({
        date: cs.at.toISOString(),
        staff: userName(ctx, cs.stop.addedById),
        property: cs.property ? `${cs.property.ref} · ${cs.property.address}` : 'No property',
        client: cs.property?.clientId ? ctx.clients.get(cs.property.clientId)?.name ?? '' : '',
        service: cs.property ? SERVICE_LABELS[cs.property.service] : '',
        reason: cs.reason?.label ?? '',
        km: round(cs.cost.km, 1),
        hours: round(cs.cost.hours, 2),
        fuelCost: round(cs.cost.fuelCost),
        timeCost: round(cs.cost.timeCost),
        totalCost: round(cs.cost.totalCost),
      }));
    return {
      ...meta('cost-per-viewing'),
      columns: [
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'staff', label: 'Staff', type: 'text' },
        { key: 'property', label: 'Property', type: 'text' },
        { key: 'client', label: 'Client', type: 'text' },
        { key: 'service', label: 'Service', type: 'text' },
        { key: 'reason', label: 'Reason', type: 'text' },
        { key: 'km', label: 'km', type: 'km' },
        { key: 'hours', label: 'Hours', type: 'hours' },
        { key: 'fuelCost', label: 'Fuel', type: 'money' },
        { key: 'timeCost', label: 'Time', type: 'money' },
        { key: 'totalCost', label: 'Total', type: 'money' },
      ],
      rows,
      notes,
    };
  }

  const groups = new Map<string, { name: string; n: number; hours: number; km: number; fuel: number; time: number }>();
  for (const cs of viewings) {
    let key: string;
    let name: string;
    if (groupBy === 'property') {
      key = cs.stop.propertyId ?? 'none';
      name = cs.property ? `${cs.property.ref} · ${cs.property.address}` : 'No property';
    } else if (groupBy === 'service') {
      key = cs.property?.service ?? 'UNKNOWN';
      name = key.charAt(0) + key.slice(1).toLowerCase();
    } else {
      key = cs.stop.addedById;
      name = userName(ctx, key);
    }
    const g = groups.get(key) ?? { name, n: 0, hours: 0, km: 0, fuel: 0, time: 0 };
    g.n += 1;
    g.hours += cs.cost.hours;
    g.km += cs.cost.km;
    g.fuel += cs.cost.fuelCost;
    g.time += cs.cost.timeCost;
    groups.set(key, g);
  }
  const rows = [...groups.values()]
    .map((g) => ({
      name: g.name,
      viewings: g.n,
      avgHours: round(g.hours / g.n, 2),
      avgKm: round(g.km / g.n, 1),
      avgCost: round((g.fuel + g.time) / g.n),
      totalHours: round(g.hours, 1),
      totalCost: round(g.fuel + g.time),
    }))
    .sort((a, z) => (z.totalCost ?? 0) - (a.totalCost ?? 0));
  return {
    ...meta('cost-per-viewing'),
    columns: [
      { key: 'name', label: groupLabel(groupBy), type: 'text' },
      { key: 'viewings', label: 'Viewings', type: 'int' },
      { key: 'avgHours', label: 'Avg hours', type: 'hours' },
      { key: 'avgKm', label: 'Avg km', type: 'km' },
      { key: 'avgCost', label: 'Avg cost', type: 'money' },
      { key: 'totalHours', label: 'Total hours', type: 'hours' },
      { key: 'totalCost', label: 'Total cost', type: 'money' },
    ],
    rows,
    notes,
  };
}

// ── 7. Property & client cost ─────────────────────────────────────────────────

function propertyClientCost(ctx: Context, groupBy: string): ReportResult {
  const { ds, f } = ctx;
  const stops = filteredStops(ctx).filter((cs) => cs.stop.propertyId);
  const byClient = groupBy === 'client';
  interface Acc {
    name: string;
    client: string;
    service: string;
    status: string;
    visits: number;
    viewings: number;
    byReason: Map<string, number>;
    hours: number;
    km: number;
    fuel: number;
    time: number;
    closures: number;
    fees: number;
  }
  const groups = new Map<string, Acc>();
  const acc = (key: string, init: () => Omit<Acc, 'visits' | 'viewings' | 'byReason' | 'hours' | 'km' | 'fuel' | 'time' | 'closures' | 'fees'>) => {
    let g = groups.get(key);
    if (!g) {
      g = { ...init(), visits: 0, viewings: 0, byReason: new Map(), hours: 0, km: 0, fuel: 0, time: 0, closures: 0, fees: 0 };
      groups.set(key, g);
    }
    return g;
  };
  const keyFor = (p: RDProperty) => (byClient ? p.clientId ?? 'none' : p.id);
  const initFor = (p: RDProperty) => () => {
    const client = p.clientId ? ctx.clients.get(p.clientId)?.name ?? '' : '';
    return byClient
      ? { name: client || 'No client', client: '', service: '', status: '' }
      : { name: `${p.ref} · ${p.address}`, client, service: p.service, status: p.status };
  };

  for (const cs of stops) {
    const p = cs.property;
    if (!p) continue;
    const g = acc(keyFor(p), initFor(p));
    g.visits += 1;
    if (cs.reason?.countsAsViewing) g.viewings += 1;
    const label = cs.reason?.label ?? 'Unknown';
    g.byReason.set(label, (g.byReason.get(label) ?? 0) + 1);
    g.hours += cs.cost.hours;
    g.km += cs.cost.km;
    g.fuel += cs.cost.fuelCost;
    g.time += cs.cost.timeCost;
  }

  for (const c of ds.closures) {
    if (!inRange(c.closedAt, f)) continue;
    const p = ctx.properties.get(c.propertyId);
    if (!p) continue;
    if (f.propertyId && p.id !== f.propertyId) continue;
    if (f.clientId && p.clientId !== f.clientId) continue;
    if (f.staffId && c.staffId !== f.staffId) continue;
    const g = acc(keyFor(p), initFor(p));
    g.closures += 1;
    g.fees += c.fee ?? 0;
  }

  const threshold = ds.settings.manyViewingsThreshold;
  const rows = [...groups.values()]
    .map((g) => {
      const total = g.fuel + g.time;
      return {
        name: g.name,
        ...(byClient ? {} : { client: g.client, service: g.service, status: g.status }),
        visits: g.visits,
        viewings: g.viewings,
        visitsByReason: [...g.byReason.entries()].map(([r, n]) => `${r} ×${n}`).join(', '),
        hours: round(g.hours, 1),
        km: round(g.km, 1),
        totalCost: round(total),
        closures: g.closures,
        fees: round(g.fees),
        costPerClosure: round(ratio(total, g.closures)),
        flag: g.viewings >= threshold && g.closures === 0 ? `${g.viewings} viewings, no closure` : '',
      };
    })
    .sort((a, z) => (z.totalCost ?? 0) - (a.totalCost ?? 0));

  return {
    ...meta('property-client-cost'),
    columns: [
      { key: 'name', label: byClient ? 'Client' : 'Property', type: 'text' },
      ...(byClient
        ? []
        : ([
            { key: 'client', label: 'Client', type: 'text' },
            { key: 'service', label: 'Service', type: 'text' },
            { key: 'status', label: 'Status', type: 'text' },
          ] as ReportColumn[])),
      { key: 'visits', label: 'Visits', type: 'int' },
      { key: 'viewings', label: 'Viewings', type: 'int' },
      { key: 'visitsByReason', label: 'Visits by reason', type: 'text' },
      { key: 'hours', label: 'Hours', type: 'hours' },
      { key: 'km', label: 'km', type: 'km' },
      { key: 'totalCost', label: 'Cost', type: 'money' },
      { key: 'closures', label: 'Closures', type: 'int' },
      { key: 'fees', label: 'Fees', type: 'money' },
      { key: 'costPerClosure', label: 'Cost per closure', type: 'money' },
      { key: 'flag', label: 'Flag', type: 'text' },
    ],
    rows,
    notes: [`Flags properties with ${threshold}+ viewings in the period and no closure.`, ...costNotes(ctx, stops)],
  };
}

// ── 8. Staff effectiveness ────────────────────────────────────────────────────

function staffEffectiveness(ctx: Context): ReportResult {
  const { ds, f } = ctx;
  const viewings = filteredStops(ctx).filter((cs) => cs.reason?.countsAsViewing);
  interface Acc {
    viewings: number;
    viewingCost: number;
    closures: number;
    fees: number;
    daysToClose: number[];
  }
  const by = new Map<string, Acc>();
  const acc = (id: string) => {
    let a = by.get(id);
    if (!a) {
      a = { viewings: 0, viewingCost: 0, closures: 0, fees: 0, daysToClose: [] };
      by.set(id, a);
    }
    return a;
  };
  for (const cs of viewings) {
    const a = acc(cs.stop.addedById);
    a.viewings += 1;
    a.viewingCost += cs.cost.totalCost;
  }
  for (const c of ds.closures) {
    if (!c.staffId || !inRange(c.closedAt, f)) continue;
    if (f.staffId && c.staffId !== f.staffId) continue;
    if (f.propertyId && c.propertyId !== f.propertyId) continue;
    if (f.clientId && ctx.properties.get(c.propertyId)?.clientId !== f.clientId) continue;
    const a = acc(c.staffId);
    a.closures += 1;
    a.fees += c.fee ?? 0;
    const first = ds.firstViewingAt[c.propertyId];
    if (first && first <= c.closedAt) a.daysToClose.push((c.closedAt.getTime() - first.getTime()) / DAY);
  }

  const rows = [...by.entries()].map(([id, a]) => ({
    name: userName(ctx, id),
    department: (() => {
      const d = ctx.users.get(id)?.department;
      return d ? DEPARTMENT_LABELS[d] : '';
    })(),
    viewings: a.viewings,
    closures: a.closures,
    viewingsPerClosure: round(ratio(a.viewings, a.closures), 1),
    viewingCost: round(a.viewingCost),
    costPerClosure: round(ratio(a.viewingCost, a.closures)),
    fees: round(a.fees),
    avgDaysToClose: round(a.daysToClose.length ? a.daysToClose.reduce((x, y) => x + y, 0) / a.daysToClose.length : null, 1),
    rank: 0 as number | null,
  }));
  // Ranked by viewings per closure (fewer is better), then cost per closure.
  // Staff without a closure rank after everyone who has one.
  rows.sort((a, z) => {
    if ((a.closures > 0) !== (z.closures > 0)) return a.closures > 0 ? -1 : 1;
    const v = (a.viewingsPerClosure ?? Infinity) - (z.viewingsPerClosure ?? Infinity);
    if (v !== 0) return v;
    return (a.costPerClosure ?? Infinity) - (z.costPerClosure ?? Infinity) || z.viewings - a.viewings;
  });
  rows.forEach((r, i) => (r.rank = r.closures > 0 ? i + 1 : null));

  return {
    ...meta('staff-effectiveness'),
    columns: [
      { key: 'rank', label: 'Rank', type: 'int' },
      { key: 'name', label: 'Staff member', type: 'text' },
      { key: 'department', label: 'Department', type: 'text' },
      { key: 'viewings', label: 'Viewings', type: 'int' },
      { key: 'closures', label: 'Closures', type: 'int' },
      { key: 'viewingsPerClosure', label: 'Viewings per closure', type: 'number' },
      { key: 'viewingCost', label: 'Viewing cost', type: 'money' },
      { key: 'costPerClosure', label: 'Cost per closure', type: 'money' },
      { key: 'fees', label: 'Fees', type: 'money' },
      { key: 'avgDaysToClose', label: 'Avg days, first viewing to closure', type: 'number' },
    ],
    rows,
    notes: [
      'Closures come from the CRM import. Ranked by viewings per closure (fewer is better), then cost per closure.',
      'Days to closure counts from the property\'s first viewing by anyone to the closure date.',
      ...costNotes(ctx, viewings),
    ],
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

function meta(id: ReportId) {
  return { id, title: REPORT_META[id].title, description: REPORT_META[id].description };
}

export function buildReport(id: ReportId, ds: ReportDataset, filters: ReportFilters, options: { groupBy?: string } = {}): ReportResult {
  const ctx = buildContext(ds, filters);
  const groupBy = options.groupBy ?? REPORT_META[id].options?.groupBy?.[0] ?? '';
  switch (id) {
    case 'fuel-efficiency':
      return fuelEfficiency(ctx);
    case 'cost-per-km':
      return costPerKm(ctx);
    case 'usage':
      return usage(ctx, groupBy);
    case 'cost-allocation':
      return costAllocation(ctx, groupBy);
    case 'compliance':
      return compliance(ctx);
    case 'cost-per-viewing':
      return costPerViewing(ctx, groupBy);
    case 'property-client-cost':
      return propertyClientCost(ctx, groupBy);
    case 'staff-effectiveness':
      return staffEffectiveness(ctx);
  }
}

/** Plain CSV for a report (RFC 4180 quoting). */
export function reportToCsv(r: ReportResult): string {
  const esc = (v: ReportCell) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [r.columns.map((c) => esc(c.label)).join(',')];
  for (const row of r.rows) lines.push(r.columns.map((c) => esc(row[c.key] ?? null)).join(','));
  return lines.join('\r\n') + '\r\n';
}
