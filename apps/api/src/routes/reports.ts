import {
  addDaysToDateKey,
  addMonths,
  buildReport,
  monthStart,
  REPORT_META,
  ReportIdSchema,
  ReportQuerySchema,
  reportToCsv,
  zonedTimeToUtc,
  type ReportDataset,
  type ReportResult,
} from '@carbooking/core';
import { num, prisma } from '@carbooking/db';
import { audit, getSettings } from '@carbooking/server';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { me } from '../lib/auth';
import { ipOf, parse } from '../lib/http';

/** Load everything the report engine needs for a period (small at this scale). */
async function loadDataset(from: Date, to: Date): Promise<ReportDataset> {
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

async function toXlsx(r: ReportResult, currency: string, period: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Fleet';
  const ws = wb.addWorksheet(r.title.slice(0, 31));
  ws.addRow([r.title]).font = { bold: true, size: 14 };
  ws.addRow([`${r.description} Period: ${period}.`]);
  ws.addRow([]);
  const header = ws.addRow(r.columns.map((c) => (c.type === 'money' ? `${c.label} (${currency})` : c.label)));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  });
  for (const row of r.rows) {
    ws.addRow(r.columns.map((c) => {
      const v = row[c.key];
      if (v == null) return null;
      if (c.type === 'date' && typeof v === 'string') return new Date(v);
      if (c.type === 'percent' && typeof v === 'number') return v / 100;
      return v;
    }));
  }
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(48, Math.max(10, c.label.length + 4, ...r.rows.slice(0, 200).map((row) => String(row[c.key] ?? '').length + 2)));
    if (c.type === 'money') col.numFmt = '#,##0.00';
    else if (c.type === 'percent') col.numFmt = '0.0%';
    else if (c.type === 'date') col.numFmt = 'dd mmm yyyy hh:mm';
    else if (c.type === 'km' || c.type === 'hours' || c.type === 'number') col.numFmt = '#,##0.0#';
  });
  if (r.notes.length) {
    ws.addRow([]);
    for (const n of r.notes) ws.addRow([n]).font = { italic: true, color: { argb: 'FF6B7280' } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function reportRoutes(app: FastifyInstance) {
  app.get('/reports', { config: { auth: 'admin' } }, async () => Object.entries(REPORT_META).map(([id, m]) => ({ id, ...m })));

  app.get<{ Params: { id: string } }>('/reports/:id', { config: { auth: 'admin' } }, async (req, reply) => {
    const id = ReportIdSchema.parse(req.params.id);
    const q = parse(ReportQuerySchema, req.query);
    const s = await getSettings();
    const from = zonedTimeToUtc(q.from, '00:00', s.timezone);
    const to = zonedTimeToUtc(addDaysToDateKey(q.to, 1), '00:00', s.timezone); // inclusive end date
    const ds = await loadDataset(from, to);
    const result = buildReport(id, ds, { from, to, carId: q.carId, staffId: q.staffId, department: q.department, reasonId: q.reasonId, propertyId: q.propertyId, clientId: q.clientId }, { groupBy: q.groupBy });
    const fileBase = `${id}_${q.from}_${q.to}`;

    if (q.format !== 'json') {
      await audit({ actorId: me(req).id, action: 'REPORT_EXPORTED', entity: 'Report', entityId: id, after: { ...q }, ip: ipOf(req) });
    }
    if (q.format === 'csv') {
      reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
      return '﻿' + reportToCsv(result);
    }
    if (q.format === 'xlsx') {
      reply
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`);
      return toXlsx(result, s.currency, `${q.from} to ${q.to}`);
    }
    return { ...result, currency: s.currency, from: q.from, to: q.to };
  });
}
