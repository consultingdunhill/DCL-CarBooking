import { describe, expect, it } from 'vitest';
import { carMonthlyStats, computeTripCost, costPerKmLookup, rateAt, stopShares, type HourlyRateLite } from './costs';
import { matchClosureRow, normalizeRow, parseClosureRow, parseCsvDate, parsePortfolioRow } from './imports';
import { buildReport, reportToCsv, type ReportDataset } from './reports';
import { DEFAULT_SETTINGS } from './settings';

const TZ = 'Africa/Nairobi';
const eat = (s: string) => new Date(`${s}+03:00`);

const rates: HourlyRateLite[] = [
  { jobRoleId: 'agent', forDriver: false, rate: 500, effectiveFrom: eat('2026-01-01T00:00:00') },
  { jobRoleId: 'agent', forDriver: false, rate: 600, effectiveFrom: eat('2026-12-01T00:00:00') },
  { jobRoleId: null, forDriver: true, rate: 300, effectiveFrom: eat('2026-01-01T00:00:00') },
];

describe('rates', () => {
  it('uses the rate in force at the time', () => {
    expect(rateAt(rates, { jobRoleId: 'agent' }, eat('2026-11-15T10:00:00'))).toBe(500);
    expect(rateAt(rates, { jobRoleId: 'agent' }, eat('2026-12-15T10:00:00'))).toBe(600);
    expect(rateAt(rates, { driver: true }, eat('2026-11-15T10:00:00'))).toBe(300);
    expect(rateAt(rates, { jobRoleId: 'manager' }, eat('2026-11-15T10:00:00'))).toBeNull();
  });
});

describe('fuel stats', () => {
  it('computes km/L, L/100 km, cost per km and the rolling average', () => {
    const stats = carMonthlyStats({
      carIds: ['c1'],
      months: ['2026-09', '2026-10', '2026-11'],
      tz: TZ,
      fuelEntries: [
        { carId: 'c1', date: eat('2026-09-05T00:00:00'), litres: 40, amount: 8000 },
        { carId: 'c1', date: eat('2026-11-05T00:00:00'), litres: 50, amount: 10_000 },
      ],
      kmRecords: [
        { carId: 'c1', at: eat('2026-09-10T10:00:00'), km: 400, kind: 'TRIP' },
        { carId: 'c1', at: eat('2026-10-10T10:00:00'), km: 200, kind: 'TRIP' },
        { carId: 'c1', at: eat('2026-11-10T10:00:00'), km: 280, kind: 'TRIP' },
        { carId: 'c1', at: eat('2026-11-12T10:00:00'), km: 20, kind: 'UNLOGGED' },
      ],
    });
    const nov = stats.find((s) => s.month === '2026-11')!;
    expect(nov.km).toBe(300);
    expect(nov.kmPerL).toBe(6);
    expect(nov.lPer100Km).toBeCloseTo(16.667, 2);
    expect(nov.costPerKm).toBeCloseTo(33.333, 2);
    // Rolling Sep–Nov: 900 km, 90 L, 18,000.
    expect(nov.rolling.kmPerL).toBe(10);
    expect(nov.rolling.costPerKm).toBe(20);
    const oct = stats.find((s) => s.month === '2026-10')!;
    expect(oct.kmPerL).toBeNull();
    expect(costPerKmLookup(stats)('c1', '2026-10')).toBeCloseTo(8000 / 600, 5);
  });
});

describe('trip cost', () => {
  const input = {
    startedAt: eat('2026-11-10T09:00:00'),
    endedAt: eat('2026-11-10T12:00:00'),
    km: 30,
    costPerKm: 20,
    people: [{ userId: 'jane', jobRoleId: 'agent' }],
    driverCount: 1,
    stops: [
      { id: 's1', arrivedAt: eat('2026-11-10T09:30:00'), departedAt: eat('2026-11-10T10:30:00') },
      { id: 's2', arrivedAt: eat('2026-11-10T11:00:00'), departedAt: eat('2026-11-10T11:30:00') },
    ],
  };

  it('splits fuel and travel time equally, and adds each stop\'s own time', () => {
    const c = computeTripCost(input, rates, 'EQUAL');
    // 3 h × (500 + 300) = 2,400 time; 30 km × 20 = 600 fuel.
    expect(c.fuelCost).toBe(600);
    expect(c.ratePerHour).toBe(800);
    expect(c.timeCost).toBe(2400);
    expect(c.totalCost).toBe(3000);
    // Travel = 3 h − 1.5 h dwell = 1.5 h → 1,200, split 600/600.
    const [s1, s2] = c.stops;
    expect(s1!.fuelCost).toBe(300);
    expect(s1!.dwellCost).toBe(800);
    expect(s1!.totalCost).toBe(300 + 600 + 800);
    expect(s2!.totalCost).toBe(300 + 600 + 400);
    expect(s1!.totalCost + s2!.totalCost).toBeCloseTo(c.totalCost, 6);
    expect(s1!.hours).toBeCloseTo(0.75 + 1, 6);
  });

  it('can split by dwell time instead', () => {
    expect(stopShares('DWELL_TIME', [1, 0.5])).toEqual([2 / 3, 1 / 3]);
    expect(stopShares('DWELL_TIME', [0, 0])).toEqual([0.5, 0.5]);
  });

  it('flags missing rates and fuel prices', () => {
    const c = computeTripCost({ ...input, costPerKm: null, people: [{ userId: 'x', jobRoleId: null }] }, [], 'EQUAL');
    expect(c.missingFuelPrice).toBe(true);
    expect(c.missingDriverRate).toBe(true);
    expect(c.missingRateUserIds).toEqual(['x']);
    expect(c.totalCost).toBe(0);
  });
});

describe('reports on a seeded month', () => {
  // November 2026: one car, one 50 L / 10,000 KES fill-up, two trips (300 km).
  // Hand-calculated: 6 km/L, 33.33 KES/km.
  const ds: ReportDataset = {
    tz: TZ,
    settings: { ...DEFAULT_SETTINGS, manyViewingsThreshold: 2 },
    cars: [{ id: 'c1', label: 'KDA 123A' }],
    drivers: [{ id: 'd1', name: 'Peter Driver' }],
    users: [
      { id: 'jane', name: 'Jane Mwangi', department: 'SALES', jobRoleId: 'agent' },
      { id: 'tom', name: 'Tom Otieno', department: 'LETTINGS', jobRoleId: 'agent' },
    ],
    reasons: [
      { id: 'view', label: 'Viewing', department: 'SALES', countsAsViewing: true },
      { id: 'insp', label: 'Inspection', department: 'PROPERTY_MANAGEMENT', countsAsViewing: false },
    ],
    properties: [
      { id: 'p1', ref: 'S-001', address: 'Westlands', clientId: 'cl1', service: 'SALES', status: 'ACTIVE' },
      { id: 'p2', ref: 'L-002', address: 'Kilimani', clientId: 'cl2', service: 'LETTINGS', status: 'ACTIVE' },
    ],
    clients: [
      { id: 'cl1', name: 'Acme Ltd' },
      { id: 'cl2', name: 'Baraka Homes' },
    ],
    bookings: [
      {
        id: 'b1',
        ownerId: 'jane',
        carId: 'c1',
        driverId: 'd1',
        status: 'COMPLETED',
        startAt: eat('2026-11-10T09:00:00'),
        expectedReturnAt: eat('2026-11-10T12:00:00'),
        passengerIds: [],
        stops: [
          { id: 's1', seq: 1, addedById: 'jane', reasonId: 'view', propertyId: 'p1', status: 'DEPARTED', arrivedAt: eat('2026-11-10T09:30:00'), departedAt: eat('2026-11-10T10:30:00') },
          { id: 's2', seq: 2, addedById: 'jane', reasonId: 'view', propertyId: 'p1', status: 'DEPARTED', arrivedAt: eat('2026-11-10T11:00:00'), departedAt: eat('2026-11-10T11:30:00') },
        ],
        trip: {
          id: 't1',
          startedAt: eat('2026-11-10T09:00:00'),
          endedAt: eat('2026-11-10T12:00:00'),
          odometerStart: 10_000,
          odometerEnd: 10_100,
          gpsDistanceKm: 70,
          unloggedKm: 0,
          events: [{ type: 'LOCATION_OFF', occurredAt: eat('2026-11-10T10:00:00') }],
        },
      },
      {
        id: 'b2',
        ownerId: 'tom',
        carId: 'c1',
        driverId: 'd1',
        status: 'COMPLETED',
        startAt: eat('2026-11-20T14:00:00'),
        expectedReturnAt: eat('2026-11-20T16:00:00'),
        passengerIds: [],
        stops: [{ id: 's3', seq: 1, addedById: 'tom', reasonId: 'insp', propertyId: 'p2', status: 'DEPARTED', arrivedAt: null, departedAt: null }],
        trip: {
          id: 't2',
          startedAt: eat('2026-11-20T14:00:00'),
          endedAt: eat('2026-11-20T16:00:00'),
          odometerStart: 10_120,
          odometerEnd: 10_300,
          gpsDistanceKm: 178,
          unloggedKm: 20,
          events: [],
        },
      },
      {
        id: 'b3',
        ownerId: 'tom',
        carId: 'c1',
        driverId: 'd1',
        status: 'NO_SHOW',
        startAt: eat('2026-11-21T09:00:00'),
        expectedReturnAt: eat('2026-11-21T10:00:00'),
        passengerIds: [],
        stops: [],
        trip: null,
      },
    ],
    fuelEntries: [{ carId: 'c1', date: eat('2026-11-05T00:00:00'), litres: 50, amount: 10_000 }],
    rates,
    closures: [{ id: 'cz1', propertyId: 'p2', staffId: 'tom', closedAt: eat('2026-11-25T00:00:00'), dealType: 'LETTING', fee: 50_000 }],
    firstViewingAt: { p2: eat('2026-11-01T00:00:00') },
  };
  const filters = { from: eat('2026-11-01T00:00:00'), to: eat('2026-12-01T00:00:00') };

  it('fuel efficiency and cost per km', () => {
    const r1 = buildReport('fuel-efficiency', ds, filters);
    expect(r1.rows[0]).toMatchObject({ car: 'KDA 123A', month: '2026-11', tripKm: 280, unloggedKm: 20, km: 300, litres: 50, kmPerL: 6 });
    const r2 = buildReport('cost-per-km', ds, filters);
    expect(r2.rows[0]).toMatchObject({ fuelCost: 10_000, costPerKm: 33.33 });
  });

  it('cost per viewing matches the hand calculation', () => {
    // Trip 1: 100 km × 33.333 = 3,333.33 fuel; 3 h × 800 = 2,400 time.
    // Each viewing gets half the fuel (1,666.67) and half the 1.5 h travel (600),
    // plus its own dwell: 1 h (800) and 0.5 h (400).
    const r = buildReport('cost-per-viewing', ds, filters, { groupBy: 'viewing' });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ km: 50, hours: 1.75, fuelCost: 1666.67, timeCost: 1400, totalCost: 3066.67 });
    expect(r.rows[1]).toMatchObject({ totalCost: 2666.67 });
  });

  it('property cost flags many viewings with no closure', () => {
    const r = buildReport('property-client-cost', ds, filters, { groupBy: 'property' });
    const p1 = r.rows.find((x) => String(x.name).startsWith('S-001'))!;
    expect(p1).toMatchObject({ visits: 2, viewings: 2, closures: 0, flag: '2 viewings, no closure', totalCost: 5733.33 });
    const p2 = r.rows.find((x) => String(x.name).startsWith('L-002'))!;
    expect(p2).toMatchObject({ closures: 1, fees: 50_000 });
  });

  it('staff effectiveness ranks staff with closures first', () => {
    const r = buildReport('staff-effectiveness', ds, filters);
    expect(r.rows[0]).toMatchObject({ name: 'Tom Otieno', closures: 1, rank: 1, avgDaysToClose: 24 });
    expect(r.rows[1]).toMatchObject({ name: 'Jane Mwangi', viewings: 2, closures: 0, rank: null });
  });

  it('compliance counts interruptions, variance and no-shows', () => {
    const r = buildReport('compliance', ds, filters);
    const jane = r.rows.find((x) => x.name === 'Jane Mwangi')!;
    // 100 km odometer vs 70 km GPS = 30% → flagged.
    expect(jane).toMatchObject({ trips: 1, locationOff: 1, varianceFlags: 1 });
    const tom = r.rows.find((x) => x.name === 'Tom Otieno')!;
    expect(tom).toMatchObject({ trips: 1, unloggedKm: 20, noShows: 1, varianceFlags: 0 });
  });

  it('usage and allocation', () => {
    const u = buildReport('usage', ds, filters, { groupBy: 'car' });
    expect(u.rows[0]).toMatchObject({ trips: 2, km: 280, bookedHours: 5 });
    const a = buildReport('cost-allocation', ds, filters, { groupBy: 'department' });
    expect(a.rows.map((x) => x.name).sort()).toEqual(['Property Management', 'Sales']);
  });

  it('filters by staff', () => {
    const r = buildReport('cost-per-viewing', ds, { ...filters, staffId: 'tom' }, { groupBy: 'viewing' });
    expect(r.rows).toHaveLength(0);
  });

  it('exports CSV', () => {
    const csv = reportToCsv(buildReport('fuel-efficiency', ds, filters));
    expect(csv.split('\r\n')[0]).toContain('km/L');
  });
});

describe('imports', () => {
  it('parses Kenyan day-first dates', () => {
    expect(parseCsvDate('31/03/2026')?.toISOString()).toBe('2026-03-31T00:00:00.000Z');
    expect(parseCsvDate('2026-03-31')?.toISOString()).toBe('2026-03-31T00:00:00.000Z');
    expect(parseCsvDate('31/02/2026')).toBeNull();
  });

  it('matches closures and sends unknown references to review', () => {
    const props = new Map([['crm-1', { id: 'p1' }]]);
    const users = new Map([['jane@co.ke', { id: 'jane' }]]);
    const good = parseClosureRow(normalizeRow({ 'Property CRM Ref': 'CRM-1', 'Agent Email': 'Jane@co.ke', 'Date Closed': '01/11/2026', 'Deal Type': 'Sale', Fee: 'KES 120,000' }));
    expect(good.fee).toBe(120_000);
    expect(matchClosureRow(good, props, users)).toMatchObject({ status: 'MATCHED', propertyId: 'p1', staffId: 'jane' });
    const bad = parseClosureRow(normalizeRow({ property_crm_reference: 'CRM-404', staff_email: 'jane@co.ke', closed_at: '2026-11-01', deal_type: 'letting' }));
    const m = matchClosureRow(bad, props, users);
    expect(m.status).toBe('UNMATCHED');
    expect(m.problems[0]).toMatch(/Unknown property CRM reference/);
  });

  it('parses portfolio rows', () => {
    const r = parsePortfolioRow(normalizeRow({ Reference: 'S-1', Address: 'Karen', Service: 'Sales', 'Client Name': 'Acme' }));
    expect(r.ok && r.row).toMatchObject({ ref: 'S-1', service: 'SALES', status: 'ACTIVE', client: { name: 'Acme', type: 'VENDOR' } });
    expect(parsePortfolioRow(normalizeRow({ Reference: 'S-1', Address: 'Karen', Service: 'cars' })).ok).toBe(false);
  });
});
