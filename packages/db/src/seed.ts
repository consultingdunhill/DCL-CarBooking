/**
 * Development seed: reference data (office, cars, driver, reasons, rates,
 * portfolio) plus ~2 months of completed trips with GPS tracks, fuel entries
 * and CRM closures so every report has something to show.
 *
 *   pnpm db:seed           # only if the database is empty
 *   pnpm db:seed --reset   # wipe everything first
 */
import { encodePolyline, haversineM, zonedTimeToUtc, addDaysToDateKey, zonedDateKey, type LatLng } from '@carbooking/core';
import { Prisma, PrismaClient, type Department } from '@prisma/client';

const prisma = new PrismaClient();
const TZ = 'Africa/Nairobi';
const reset = process.argv.includes('--reset');

// Deterministic pseudo-random numbers so re-seeding gives the same data.
let seed = 42;
const rand = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

const OFFICE: LatLng & { name: string; address: string } = {
  name: 'Head Office',
  address: 'Westlands Square, Waiyaki Way, Nairobi',
  lat: -1.26745,
  lng: 36.80755,
};

const PROPERTIES = [
  { ref: 'S-1001', crmRef: 'CRM-P-1001', address: '4 bed villa, Lavington Green, Lavington', lat: -1.2794, lng: 36.7698, service: 'SALES', client: 'Mwangi Family Trust' },
  { ref: 'S-1002', crmRef: 'CRM-P-1002', address: 'Plot 12, Karen Road, Karen', lat: -1.3197, lng: 36.7076, service: 'SALES', client: 'Karen Estates Ltd' },
  { ref: 'S-1003', crmRef: 'CRM-P-1003', address: 'Apartment 5B, Riverside Drive, Riverside', lat: -1.2690, lng: 36.7905, service: 'SALES', client: 'Odhiambo Holdings' },
  { ref: 'S-1004', crmRef: 'CRM-P-1004', address: 'Townhouse 3, Runda Grove, Runda', lat: -1.2185, lng: 36.8030, service: 'SALES', client: 'Karen Estates Ltd' },
  { ref: 'L-2001', crmRef: 'CRM-P-2001', address: 'Unit 7, Kindaruma Road, Kilimani', lat: -1.2905, lng: 36.7860, service: 'LETTINGS', client: 'Baraka Homes' },
  { ref: 'L-2002', crmRef: 'CRM-P-2002', address: 'Flat 12, Gitanga Road, Kileleshwa', lat: -1.2766, lng: 36.7774, service: 'LETTINGS', client: 'Baraka Homes' },
  { ref: 'L-2003', crmRef: 'CRM-P-2003', address: '3 bed, 1st Parklands Avenue, Parklands', lat: -1.2598, lng: 36.8167, service: 'LETTINGS', client: 'Shah Properties' },
  { ref: 'M-3001', crmRef: 'CRM-P-3001', address: 'Upper Hill Court, Matumbato Road, Upper Hill', lat: -1.2985, lng: 36.8150, service: 'MANAGEMENT', client: 'Upper Hill Court Owners' },
  { ref: 'M-3002', crmRef: 'CRM-P-3002', address: 'Garden Estate block C, Thika Road', lat: -1.2290, lng: 36.8740, service: 'MANAGEMENT', client: 'Shah Properties' },
  { ref: 'L-2004', crmRef: 'CRM-P-2004', address: 'Studio 4, Ngong Road, Adams Arcade', lat: -1.3005, lng: 36.7780, service: 'LETTINGS', client: 'Odhiambo Holdings' },
] as const;

const REASONS: { label: string; department: Department; countsAsViewing: boolean; needsProperty: boolean }[] = [
  { label: 'Sales viewing', department: 'SALES', countsAsViewing: true, needsProperty: true },
  { label: 'Valuation', department: 'SALES', countsAsViewing: false, needsProperty: true },
  { label: 'Vendor meeting', department: 'SALES', countsAsViewing: false, needsProperty: false },
  { label: 'Lettings viewing', department: 'LETTINGS', countsAsViewing: true, needsProperty: true },
  { label: 'Check-in / check-out inventory', department: 'LETTINGS', countsAsViewing: false, needsProperty: true },
  { label: 'Landlord meeting', department: 'LETTINGS', countsAsViewing: false, needsProperty: false },
  { label: 'Property inspection', department: 'PROPERTY_MANAGEMENT', countsAsViewing: false, needsProperty: true },
  { label: 'Maintenance visit', department: 'PROPERTY_MANAGEMENT', countsAsViewing: false, needsProperty: true },
  { label: 'Bank / KRA / Lands office', department: 'OTHER', countsAsViewing: false, needsProperty: false },
  { label: 'Other', department: 'OTHER', countsAsViewing: false, needsProperty: false },
];

async function wipe() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'spatial_ref_sys')`;
  if (tables.length === 0) return;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

/** Points along a route, ~every 400 m at ~25 km/h, with dwell points at each stop. */
function simulateTrack(waypoints: LatLng[], start: Date, dwellMin: number[]) {
  const points: { lat: number; lng: number; recordedAt: Date; accuracy: number; speed: number; isMoving: boolean; battery: number }[] = [];
  let t = start.getTime();
  let battery = 80 + Math.floor(rand() * 20);
  const arrivals: { arrivedAt: Date; departedAt: Date }[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1]!;
    const b = waypoints[i]!;
    const m = haversineM(a, b) * 1.3; // roads aren't straight
    const steps = Math.max(2, Math.round(m / 400));
    const speedMs = (20 + rand() * 10) / 3.6;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      t += (m / steps / speedMs) * 1000;
      points.push({
        lat: a.lat + (b.lat - a.lat) * f + (rand() - 0.5) * 0.0004 * (s < steps ? 1 : 0),
        lng: a.lng + (b.lng - a.lng) * f + (rand() - 0.5) * 0.0004 * (s < steps ? 1 : 0),
        recordedAt: new Date(t),
        accuracy: 5 + Math.round(rand() * 10),
        speed: speedMs,
        isMoving: true,
        battery: (battery -= rand() < 0.2 ? 1 : 0),
      });
    }
    const dwell = dwellMin[i - 1];
    if (dwell != null) {
      const arrivedAt = new Date(t);
      for (let k = 1; k * 5 <= dwell; k++) {
        points.push({ lat: b.lat, lng: b.lng, recordedAt: new Date(t + k * 5 * 60_000), accuracy: 8, speed: 0, isMoving: false, battery });
      }
      t += dwell * 60_000;
      points.push({ lat: b.lat, lng: b.lng, recordedAt: new Date(t), accuracy: 6, speed: 0, isMoving: true, battery });
      arrivals.push({ arrivedAt, departedAt: new Date(t) });
    }
  }
  // Park at the office for a couple of minutes.
  for (const k of [1, 2, 3]) {
    const last = waypoints[waypoints.length - 1]!;
    points.push({ lat: last.lat, lng: last.lng, recordedAt: new Date(t + k * 60_000), accuracy: 6, speed: 0, isMoving: false, battery });
  }
  const endedAt = new Date(t + 4 * 60_000);
  let gpsM = 0;
  for (let i = 1; i < points.length; i++) gpsM += haversineM(points[i - 1]!, points[i]!);
  return { points, arrivals, endedAt, gpsKm: gpsM / 1000 };
}

async function main() {
  if (reset) await wipe();
  else if ((await prisma.user.count()) > 0) {
    console.log('Database already has data. Run with --reset to wipe and re-seed.');
    return;
  }

  const office = await prisma.office.create({ data: { ...OFFICE, arrivalRadiusM: 20, wakeupRadiusM: 150 } });
  const driver = await prisma.driver.create({ data: { name: 'Peter Kamau', phone: '+254711000001' } });

  const roles = Object.fromEntries(
    await Promise.all(
      ['Sales Agent', 'Lettings Negotiator', 'Property Manager', 'Administrator'].map(async (name) => [name, await prisma.jobRole.create({ data: { name } })]),
    ),
  ) as Record<string, { id: string }>;
  const rateStart = zonedTimeToUtc('2025-01-01', '00:00', TZ);
  await prisma.hourlyRate.createMany({
    data: [
      { jobRoleId: roles['Sales Agent']!.id, rate: 650, effectiveFrom: rateStart },
      { jobRoleId: roles['Lettings Negotiator']!.id, rate: 550, effectiveFrom: rateStart },
      { jobRoleId: roles['Property Manager']!.id, rate: 750, effectiveFrom: rateStart },
      { jobRoleId: roles['Administrator']!.id, rate: 450, effectiveFrom: rateStart },
      { forDriver: true, rate: 300, effectiveFrom: rateStart },
    ],
  });

  const mkUser = (name: string, email: string, role: 'STAFF' | 'ADMIN', department: Department, jobRole: string, phone: string) =>
    prisma.user.create({
      data: { name, email, role, department, jobRoleId: roles[jobRole]!.id, phone, privacyAckAt: new Date(), privacyAckVersion: '2026-10' },
    });
  const admin = await mkUser('Grace Wanjiru', 'grace.wanjiru@example.co.ke', 'ADMIN', 'OTHER', 'Administrator', '+254722000010');
  const jane = await mkUser('Jane Mwangi', 'jane.mwangi@example.co.ke', 'STAFF', 'SALES', 'Sales Agent', '+254722000011');
  const tom = await mkUser('Tom Otieno', 'tom.otieno@example.co.ke', 'STAFF', 'LETTINGS', 'Lettings Negotiator', '+254722000012');
  const amina = await mkUser('Amina Hassan', 'amina.hassan@example.co.ke', 'STAFF', 'PROPERTY_MANAGEMENT', 'Property Manager', '+254722000013');
  const brian = await mkUser('Brian Kiprop', 'brian.kiprop@example.co.ke', 'STAFF', 'SALES', 'Sales Agent', '+254722000014');
  const staff = [jane, tom, amina, brian];

  const cars = [
    await prisma.car.create({ data: { registration: 'KDA 123A', make: 'Toyota', model: 'Axio', color: 'Silver', seats: 5, fuelType: 'PETROL', homeOfficeId: office.id, currentOdometer: 84_210 } }),
    await prisma.car.create({ data: { registration: 'KDB 456B', make: 'Toyota', model: 'Fielder', color: 'White', seats: 5, fuelType: 'PETROL', homeOfficeId: office.id, currentOdometer: 61_870 } }),
    await prisma.car.create({ data: { registration: 'KDC 789C', make: 'Nissan', model: 'X-Trail', color: 'Grey', seats: 7, fuelType: 'DIESEL', status: 'MAINTENANCE', homeOfficeId: office.id, currentOdometer: 102_450 } }),
  ];

  const reasons = await Promise.all(REASONS.map((r, i) => prisma.visitReason.create({ data: { ...r, sortOrder: i } })));
  const reason = (label: string) => reasons.find((r) => r.label === label)!;

  const clientNames = [...new Set(PROPERTIES.map((p) => p.client))];
  const clients = Object.fromEntries(
    await Promise.all(
      clientNames.map(async (name, i) => [
        name,
        await prisma.client.create({
          data: { name, type: PROPERTIES.find((p) => p.client === name)!.service === 'SALES' ? 'VENDOR' : 'LANDLORD', phone: `+2547330000${10 + i}`, crmRef: `CRM-C-${100 + i}` },
        }),
      ]),
    ),
  ) as Record<string, { id: string }>;
  const properties = await Promise.all(
    PROPERTIES.map((p) =>
      prisma.property.create({
        data: { ref: p.ref, crmRef: p.crmRef, address: p.address, lat: p.lat, lng: p.lng, service: p.service, clientId: clients[p.client]!.id, createdById: admin.id },
      }),
    ),
  );

  // ── History: ~2 months of completed trips ──
  const today = zonedDateKey(new Date(), TZ);
  const odo = new Map(cars.map((c) => [c.id, c.currentOdometer - 2500]));
  // Fill-ups follow the km driven (Nairobi stop-start traffic: ~10–13 km/L).
  const kmSinceFill = new Map(cars.map((c) => [c.id, 0]));
  let tripCount = 0;
  const firstViewing = new Map<string, Date>();

  for (let d = -60; d <= -1; d++) {
    const day = addDaysToDateKey(today, d);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday === 0) continue;
    const tripsToday = weekday === 6 ? 1 : 1 + Math.floor(rand() * 2);
    for (let n = 0; n < tripsToday; n++) {
      const owner = pick(staff);
      const car = cars[n % 2]!;
      const startAt = zonedTimeToUtc(day, n === 0 ? '09:00' : '14:00', TZ);
      const stopCount = 1 + Math.floor(rand() * 3);
      const deptProps = properties.filter((p) =>
        owner.department === 'SALES' ? p.service === 'SALES' : owner.department === 'LETTINGS' ? p.service === 'LETTINGS' : p.service === 'MANAGEMENT',
      );
      const chosen = Array.from({ length: stopCount }, () => pick(deptProps));
      const stopReasons = chosen.map((p) =>
        p.service === 'SALES'
          ? reason(rand() < 0.8 ? 'Sales viewing' : 'Valuation')
          : p.service === 'LETTINGS'
            ? reason(rand() < 0.75 ? 'Lettings viewing' : 'Check-in / check-out inventory')
            : reason(rand() < 0.6 ? 'Property inspection' : 'Maintenance visit'),
      );
      const dwell = chosen.map(() => 15 + Math.floor(rand() * 40));
      const track = simulateTrack([OFFICE, ...chosen.map((p) => ({ lat: p.lat!, lng: p.lng! })), OFFICE], new Date(startAt.getTime() + 5 * 60_000), dwell);
      const expectedReturnAt = new Date(Math.ceil((track.endedAt.getTime() + 20 * 60_000) / 900_000) * 900_000);

      const unlogged = rand() < 0.1 ? 5 + Math.floor(rand() * 20) : 0;
      const odoStart = odo.get(car.id)! + unlogged;
      const tripKm = Math.round(track.gpsKm * (1 + (rand() - 0.4) * 0.12));
      const odoEnd = odoStart + tripKm;
      odo.set(car.id, odoEnd);
      kmSinceFill.set(car.id, kmSinceFill.get(car.id)! + tripKm + unlogged);

      const booking = await prisma.booking.create({
        data: {
          ownerId: owner.id,
          driverId: driver.id,
          carId: car.id,
          status: 'COMPLETED',
          startAt,
          expectedReturnAt,
          reasonId: stopReasons[0]!.id,
          plannedDistanceKm: Math.round(track.gpsKm * 10) / 10,
          plannedPolyline: encodePolyline([OFFICE, ...chosen.map((p) => ({ lat: p.lat!, lng: p.lng! })), OFFICE]),
          plannedDurationMin: Math.round((track.endedAt.getTime() - startAt.getTime()) / 60_000),
          decidedById: admin.id,
          decidedAt: new Date(startAt.getTime() - 86_400_000),
          createdAt: new Date(startAt.getTime() - 2 * 86_400_000),
          stops: {
            create: chosen.map((p, i) => ({
              seq: i + 1,
              propertyId: p.id,
              address: p.address,
              lat: p.lat!,
              lng: p.lng!,
              addedById: owner.id,
              reasonId: stopReasons[i]!.id,
              status: 'DEPARTED',
              arrivedAt: track.arrivals[i]?.arrivedAt,
              departedAt: track.arrivals[i]?.departedAt,
            })),
          },
        },
      });
      chosen.forEach((p, i) => {
        if (stopReasons[i]!.countsAsViewing && !firstViewing.has(p.id)) firstViewing.set(p.id, track.arrivals[i]!.arrivedAt);
      });

      const tripStart = new Date(startAt.getTime() + 5 * 60_000);
      const last = track.points[track.points.length - 1]!;
      const trip = await prisma.trip.create({
        data: {
          bookingId: booking.id,
          startedAt: tripStart,
          endedAt: track.endedAt,
          odometerStart: odoStart,
          odometerEnd: odoEnd,
          photoStartKey: 'seed/odometer-placeholder.jpg',
          photoEndKey: 'seed/odometer-placeholder.jpg',
          unloggedKm: unlogged,
          endMethod: rand() < 0.6 ? 'GEOFENCE' : 'MANUAL',
          gpsDistanceKm: Math.round(track.gpsKm * 100) / 100,
          startRequestId: `seed-start-${booking.id}`,
          endRequestId: `seed-end-${booking.id}`,
          lastLat: last.lat,
          lastLng: last.lng,
          lastSeenAt: last.recordedAt,
          lastContactAt: last.recordedAt,
          lastBattery: last.battery,
          trackingStatus: 'STOPPED',
          trackingStatusSince: track.endedAt,
          officeArrivedAt: last.recordedAt,
        },
      });
      await prisma.locationPoint.createMany({ data: track.points.map((p) => ({ ...p, tripId: trip.id })) });

      const events: Prisma.TrackingEventCreateManyInput[] = [
        { tripId: trip.id, type: 'TRIP_STARTED', occurredAt: tripStart, source: 'DEVICE', details: { odometer: odoStart, unloggedKm: unlogged } },
        ...track.arrivals.flatMap((a, i) => [
          { tripId: trip.id, type: 'STOP_ARRIVED' as const, occurredAt: a.arrivedAt, source: 'SERVER' as const, details: { seq: i + 1 } },
          { tripId: trip.id, type: 'STOP_DEPARTED' as const, occurredAt: a.departedAt, source: 'SERVER' as const, details: { seq: i + 1 } },
        ]),
        { tripId: trip.id, type: 'TRIP_ENDED', occurredAt: track.endedAt, source: 'DEVICE', details: { odometer: odoEnd, method: 'MANUAL', tripKm, gpsKm: Math.round(track.gpsKm * 100) / 100 } },
      ];
      if (rand() < 0.08) {
        const mid = track.points[Math.floor(track.points.length / 2)]!;
        events.push(
          { tripId: trip.id, type: 'LOCATION_OFF', occurredAt: mid.recordedAt, source: 'DEVICE', lat: mid.lat, lng: mid.lng },
          { tripId: trip.id, type: 'LOCATION_ON', occurredAt: new Date(mid.recordedAt.getTime() + 12 * 60_000), source: 'DEVICE' },
        );
      }
      await prisma.trackingEvent.createMany({ data: events });
      tripCount++;
    }

    // Weekly fill-ups for the two cars in use.
    if (weekday === 1) {
      for (const car of cars.slice(0, 2)) {
        const km = kmSinceFill.get(car.id)!;
        if (km < 20) continue;
        kmSinceFill.set(car.id, 0);
        const litres = Math.round((km / (10 + rand() * 3)) * 10) / 10;
        await prisma.fuelEntry.create({
          data: {
            carId: car.id,
            date: zonedTimeToUtc(day, '08:00', TZ),
            litres,
            amount: Math.round(litres * 182.5),
            odometer: odo.get(car.id),
            enteredById: admin.id,
          },
        });
      }
    }
  }
  for (const car of cars.slice(0, 2)) await prisma.car.update({ where: { id: car.id }, data: { currentOdometer: odo.get(car.id)! } });

  // A few no-shows, rejections and cancellations for the compliance report.
  for (const [i, status] of (['NO_SHOW', 'REJECTED', 'CANCELLED', 'REJECTED'] as const).entries()) {
    const day = addDaysToDateKey(today, -50 + i * 11);
    const owner = staff[i % staff.length]!;
    const p = properties[i]!;
    await prisma.booking.create({
      data: {
        ownerId: owner.id,
        driverId: driver.id,
        carId: cars[i % 2]!.id,
        status,
        startAt: zonedTimeToUtc(day, '16:00', TZ),
        expectedReturnAt: zonedTimeToUtc(day, '17:30', TZ),
        reasonId: reasons[0]!.id,
        decidedById: status === 'REJECTED' ? admin.id : null,
        decidedAt: status === 'REJECTED' ? zonedTimeToUtc(day, '10:00', TZ) : null,
        rejectionReason: status === 'REJECTED' ? 'Car needed for a management inspection' : null,
        cancelledAt: status === 'CANCELLED' ? zonedTimeToUtc(day, '12:00', TZ) : null,
        stops: {
          create: [{ seq: 1, propertyId: p.id, address: p.address, lat: p.lat!, lng: p.lng!, addedById: owner.id, reasonId: reasons[0]!.id }],
        },
      },
    });
  }

  // CRM closures for a handful of viewed properties.
  const viewed = [...firstViewing.entries()].slice(0, 4);
  for (const [i, [propertyId, first]] of viewed.entries()) {
    const p = properties.find((x) => x.id === propertyId)!;
    const closer = p.service === 'SALES' ? (i % 2 ? brian : jane) : tom;
    await prisma.closure.create({
      data: {
        propertyId,
        staffId: closer.id,
        closedAt: new Date(first.getTime() + (10 + i * 6) * 86_400_000),
        dealType: p.service === 'SALES' ? 'SALE' : 'LETTING',
        fee: p.service === 'SALES' ? 450_000 + i * 50_000 : 85_000,
        crmRef: `CRM-D-${5000 + i}`,
      },
    });
    await prisma.property.update({ where: { id: propertyId }, data: { status: p.service === 'SALES' ? 'SOLD' : 'LET' } });
  }

  // ── Upcoming: one approved and one pending request ──
  const tomorrow = addDaysToDateKey(today, 1);
  const p1 = properties[0]!;
  const p2 = properties[4]!;
  await prisma.booking.create({
    data: {
      ownerId: jane.id,
      driverId: driver.id,
      carId: cars[0]!.id,
      status: 'APPROVED',
      startAt: zonedTimeToUtc(tomorrow, '10:00', TZ),
      expectedReturnAt: zonedTimeToUtc(tomorrow, '13:00', TZ),
      reasonId: reason('Sales viewing').id,
      decidedById: admin.id,
      decidedAt: new Date(),
      stops: { create: [{ seq: 1, propertyId: p1.id, address: p1.address, lat: p1.lat!, lng: p1.lng!, addedById: jane.id, reasonId: reason('Sales viewing').id }] },
    },
  });
  await prisma.booking.create({
    data: {
      ownerId: tom.id,
      driverId: driver.id,
      carId: cars[1]!.id,
      status: 'PENDING',
      startAt: zonedTimeToUtc(tomorrow, '14:30', TZ),
      expectedReturnAt: zonedTimeToUtc(tomorrow, '16:30', TZ),
      reasonId: reason('Lettings viewing').id,
      stops: { create: [{ seq: 1, propertyId: p2.id, address: p2.address, lat: p2.lat!, lng: p2.lng!, addedById: tom.id, reasonId: reason('Lettings viewing').id }] },
    },
  });

  console.log(`Seeded: 1 office, ${cars.length} cars, 1 driver, ${staff.length + 1} users, ${properties.length} properties, ${tripCount} past trips.`);
  console.log(`Admin: ${admin.email}. Staff: ${staff.map((s) => s.email).join(', ')}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
