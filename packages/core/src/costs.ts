import type { StopCostSplit } from './enums';
import { addMonths, HOUR, monthKey } from './time';

// ── Fuel efficiency & cost per km ─────────────────────────────────────────────

export interface FuelEntryLite {
  carId: string;
  date: Date;
  litres: number;
  amount: number;
}

export interface KmRecord {
  carId: string;
  at: Date;
  km: number;
  kind: 'TRIP' | 'UNLOGGED';
}

export interface Efficiency {
  km: number;
  litres: number;
  fuelCost: number;
  kmPerL: number | null;
  lPer100Km: number | null;
  costPerKm: number | null;
}

export interface CarMonthStats extends Efficiency {
  carId: string;
  month: string;
  tripKm: number;
  unloggedKm: number;
  /** Rolling window (default 3 months) ending with this month. */
  rolling: Efficiency;
}

export function efficiency(km: number, litres: number, fuelCost: number): Efficiency {
  return {
    km,
    litres,
    fuelCost,
    kmPerL: litres > 0 && km > 0 ? km / litres : null,
    lPer100Km: litres > 0 && km > 0 ? (litres / km) * 100 : null,
    costPerKm: km > 0 && fuelCost > 0 ? fuelCost / km : null,
  };
}

interface Bucket {
  tripKm: number;
  unloggedKm: number;
  litres: number;
  fuelCost: number;
}

/**
 * Per-car, per-month km, litres and cost. Fill-ups rarely line up with a
 * month's actual driving, so each month also carries a rolling average.
 * Pass fuel and km data from `rollingMonths - 1` months before the first
 * month so the early rolling figures are complete.
 */
export function carMonthlyStats(input: {
  carIds: string[];
  months: string[];
  fuelEntries: FuelEntryLite[];
  kmRecords: KmRecord[];
  tz: string;
  rollingMonths?: number;
}): CarMonthStats[] {
  const rollingMonths = input.rollingMonths ?? 3;
  const buckets = new Map<string, Bucket>();
  const bucket = (carId: string, month: string) => {
    const key = `${carId}|${month}`;
    let b = buckets.get(key);
    if (!b) {
      b = { tripKm: 0, unloggedKm: 0, litres: 0, fuelCost: 0 };
      buckets.set(key, b);
    }
    return b;
  };
  for (const r of input.kmRecords) {
    const b = bucket(r.carId, monthKey(r.at, input.tz));
    if (r.kind === 'TRIP') b.tripKm += r.km;
    else b.unloggedKm += r.km;
  }
  for (const f of input.fuelEntries) {
    const b = bucket(f.carId, monthKey(f.date, input.tz));
    b.litres += f.litres;
    b.fuelCost += f.amount;
  }

  const out: CarMonthStats[] = [];
  for (const carId of input.carIds) {
    for (const month of input.months) {
      const b = buckets.get(`${carId}|${month}`) ?? { tripKm: 0, unloggedKm: 0, litres: 0, fuelCost: 0 };
      let rKm = 0;
      let rLitres = 0;
      let rCost = 0;
      for (let i = 0; i < rollingMonths; i++) {
        const rb = buckets.get(`${carId}|${addMonths(month, -i)}`);
        if (!rb) continue;
        rKm += rb.tripKm + rb.unloggedKm;
        rLitres += rb.litres;
        rCost += rb.fuelCost;
      }
      out.push({
        carId,
        month,
        tripKm: b.tripKm,
        unloggedKm: b.unloggedKm,
        ...efficiency(b.tripKm + b.unloggedKm, b.litres, b.fuelCost),
        rolling: efficiency(rKm, rLitres, rCost),
      });
    }
  }
  return out;
}

/**
 * Fuel cost per km for a car in a month: the rolling figure, then the month's
 * own figure, then the car's average across every month supplied.
 */
export function costPerKmLookup(stats: CarMonthStats[]): (carId: string, month: string) => number | null {
  const byKey = new Map(stats.map((s) => [`${s.carId}|${s.month}`, s]));
  const overall = new Map<string, number | null>();
  const carIds = new Set(stats.map((s) => s.carId));
  for (const carId of carIds) {
    let km = 0;
    let cost = 0;
    for (const s of stats) {
      if (s.carId !== carId) continue;
      km += s.km;
      cost += s.fuelCost;
    }
    overall.set(carId, km > 0 && cost > 0 ? cost / km : null);
  }
  return (carId, month) => {
    const s = byKey.get(`${carId}|${month}`);
    return s?.rolling.costPerKm ?? s?.costPerKm ?? overall.get(carId) ?? null;
  };
}

// ── Hourly rates ──────────────────────────────────────────────────────────────

export interface HourlyRateLite {
  /** Null for the driver rate. */
  jobRoleId: string | null;
  forDriver: boolean;
  rate: number;
  effectiveFrom: Date;
}

/** The rate in force at `at`. Rates are dated, so past costs don't change when a rate does. */
export function rateAt(
  rates: HourlyRateLite[],
  subject: { driver: true } | { jobRoleId: string | null },
  at: Date,
): number | null {
  let best: HourlyRateLite | null = null;
  for (const r of rates) {
    const matches = 'driver' in subject ? r.forDriver : !r.forDriver && r.jobRoleId != null && r.jobRoleId === subject.jobRoleId;
    if (!matches || r.effectiveFrom > at) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best?.rate ?? null;
}

// ── Trip & stop cost ──────────────────────────────────────────────────────────

export interface CostStopInput {
  id: string;
  arrivedAt: Date | null;
  departedAt: Date | null;
}

export interface TripCostInput {
  startedAt: Date;
  endedAt: Date;
  /** Odometer km for the trip. */
  km: number;
  costPerKm: number | null;
  /** Staff on board: the trip owner and passengers. */
  people: { userId: string; jobRoleId: string | null }[];
  driverCount: number;
  /** Stops that took place (not proposed, rejected or skipped), in route order. */
  stops: CostStopInput[];
}

export interface StopCost {
  stopId: string;
  share: number;
  km: number;
  fuelCost: number;
  travelHours: number;
  travelCost: number;
  dwellHours: number;
  dwellCost: number;
  hours: number;
  timeCost: number;
  totalCost: number;
}

export interface TripCost {
  km: number;
  fuelCost: number;
  hours: number;
  travelHours: number;
  dwellHours: number;
  /** Combined hourly rate of everyone on board, driver included. */
  ratePerHour: number;
  timeCost: number;
  totalCost: number;
  missingRateUserIds: string[];
  missingDriverRate: boolean;
  missingFuelPrice: boolean;
  stops: StopCost[];
}

function dwellHours(stop: CostStopInput, startedAt: Date, endedAt: Date): number {
  if (!stop.arrivedAt || !stop.departedAt) return 0;
  const a = Math.max(stop.arrivedAt.getTime(), startedAt.getTime());
  const d = Math.min(stop.departedAt.getTime(), endedAt.getTime());
  return Math.max(0, d - a) / HOUR;
}

/**
 * How a trip's fuel and travel time are shared across its stops. The business
 * hasn't settled the formula yet, so this is pluggable via the `stopCostSplit`
 * setting. Shares always sum to 1.
 */
export function stopShares(split: StopCostSplit, dwell: number[]): number[] {
  const n = dwell.length;
  if (n === 0) return [];
  if (split === 'DWELL_TIME') {
    const total = dwell.reduce((a, b) => a + b, 0);
    if (total > 0) return dwell.map((d) => d / total);
  }
  return dwell.map(() => 1 / n);
}

/**
 * Trip cost = fuel (km × cost per km) + time (hours × everyone's hourly rate).
 * Stop cost = its share of fuel and travel time + the time spent at the stop.
 * Stop costs add up to the trip cost.
 */
export function computeTripCost(input: TripCostInput, rates: HourlyRateLite[], split: StopCostSplit): TripCost {
  const at = input.startedAt;
  const hours = Math.max(0, input.endedAt.getTime() - input.startedAt.getTime()) / HOUR;

  const missingRateUserIds: string[] = [];
  let ratePerHour = 0;
  for (const p of input.people) {
    const r = rateAt(rates, { jobRoleId: p.jobRoleId }, at);
    if (r == null) missingRateUserIds.push(p.userId);
    else ratePerHour += r;
  }
  const driverRate = rateAt(rates, { driver: true }, at);
  const missingDriverRate = input.driverCount > 0 && driverRate == null;
  ratePerHour += (driverRate ?? 0) * input.driverCount;

  const fuelCost = input.costPerKm != null ? input.km * input.costPerKm : 0;
  const dwell = input.stops.map((s) => dwellHours(s, input.startedAt, input.endedAt));
  const totalDwell = Math.min(hours, dwell.reduce((a, b) => a + b, 0));
  const travelHours = Math.max(0, hours - totalDwell);
  const travelCost = travelHours * ratePerHour;
  const shares = stopShares(split, dwell);

  const stops = input.stops.map<StopCost>((s, i) => {
    const share = shares[i]!;
    const dwellH = dwell[i]!;
    const stopTravelHours = travelHours * share;
    const stopTravelCost = travelCost * share;
    const dwellCost = dwellH * ratePerHour;
    const stopFuel = fuelCost * share;
    return {
      stopId: s.id,
      share,
      km: input.km * share,
      fuelCost: stopFuel,
      travelHours: stopTravelHours,
      travelCost: stopTravelCost,
      dwellHours: dwellH,
      dwellCost,
      hours: stopTravelHours + dwellH,
      timeCost: stopTravelCost + dwellCost,
      totalCost: stopFuel + stopTravelCost + dwellCost,
    };
  });

  const timeCost = (travelHours + totalDwell) * ratePerHour;
  return {
    km: input.km,
    fuelCost,
    hours,
    travelHours,
    dwellHours: totalDwell,
    ratePerHour,
    timeCost,
    totalCost: fuelCost + timeCost,
    missingRateUserIds,
    missingDriverRate,
    missingFuelPrice: input.costPerKm == null && input.km > 0,
    stops,
  };
}
