import { addMonths, monthStart, type ReportDataset } from '@carbooking/core';
import { num, prisma } from '@carbooking/db';
import { getSettings } from './settings';

/** Load everything the report engine needs for a period (small at this scale). */
export async function loadDataset(from: Date, to: Date): Promise<ReportDataset> {
  const s = await getSettings();
  const tz = s.timezone;
  // Two extra months before `from` for the rolling 3-month fuel figures.
  const fromMonth = from.toISOString().slice(0, 7);
  const bufferStart = monthStart(addMonths(fromMonth, -3), tz);

  const [cars, drivers, users, reasons, properties, clients, bookings, fuel, rates, closures, firstViewings] = await Promise.all([
    prisma.car.findMany({ orderBy: { registration: 'asc' } }),
    prisma.driver.findMany(),
    prisma.user.findMany({ select: { id: true, name: true, department: true, jobRoleId: true } }),
    prisma.visitReason.findMany(),
    prisma.property.findMany({ select: { id: true, ref: true, address: true, clientId: true, service: true, status: true } }),
    prisma.client.findMany({ select: { id: true, name: true } }),
    prisma.booking.findMany({
      where: { startAt: { gte: bufferStart, lt: to } },
      select: {
        id: true,
        ownerId: true,
        carId: true,
        driverId: true,
        status: true,
        startAt: true,
        expectedReturnAt: true,
        passengers: { select: { userId: true } },
        stops: { select: { id: true, seq: true, addedById: true, reasonId: true, propertyId: true, status: true, arrivedAt: true, departedAt: true } },
        trip: {
          select: {
            id: true,
            startedAt: true,
            endedAt: true,
            odometerStart: true,
            odometerEnd: true,
            gpsDistanceKm: true,
            unloggedKm: true,
            events: { where: { type: { in: ['LOCATION_OFF', 'TRACKING_LOST', 'OVERDUE', 'AWAITING_ODOMETER'] } }, select: { type: true, occurredAt: true } },
          },
        },
      },
    }),
    prisma.fuelEntry.findMany({ where: { date: { gte: bufferStart, lt: to } } }),
    prisma.hourlyRate.findMany(),
    prisma.closure.findMany({ where: { closedAt: { gte: from, lt: to } } }),
    prisma.$queryRaw<{ propertyId: string; first: Date }[]>`
      SELECT s."propertyId", MIN(COALESCE(s."arrivedAt", t."startedAt", b."startAt")) AS first
      FROM "BookingStop" s
      JOIN "VisitReason" r ON r.id = s."reasonId" AND r."countsAsViewing"
      JOIN "Booking" b ON b.id = s."bookingId" AND b.status IN ('IN_PROGRESS', 'COMPLETED', 'AWAITING_ODOMETER')
      LEFT JOIN "Trip" t ON t."bookingId" = b.id
      WHERE s."propertyId" IS NOT NULL AND s.status IN ('PLANNED', 'ARRIVED', 'DEPARTED')
      GROUP BY s."propertyId"`,
  ]);

  return {
    tz,
    settings: s,
    cars: cars.map((c) => ({ id: c.id, label: `${c.registration} (${c.make} ${c.model})` })),
    drivers,
    users,
    reasons,
    properties,
    clients,
    bookings: bookings.map((b) => ({ ...b, passengerIds: b.passengers.map((p) => p.userId) })),
    fuelEntries: fuel.map((f) => ({ carId: f.carId, date: f.date, litres: num(f.litres)!, amount: num(f.amount)! })),
    rates: rates.map((r) => ({ jobRoleId: r.jobRoleId, forDriver: r.forDriver, rate: num(r.rate)!, effectiveFrom: r.effectiveFrom })),
    closures: closures.map((c) => ({ id: c.id, propertyId: c.propertyId, staffId: c.staffId, closedAt: c.closedAt, dealType: c.dealType, fee: num(c.fee) })),
    firstViewingAt: Object.fromEntries(firstViewings.map((r) => [r.propertyId, r.first])),
  };
}
