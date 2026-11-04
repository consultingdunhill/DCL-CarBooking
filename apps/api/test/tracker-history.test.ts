/**
 * A car's GPS history exported from Oversee, uploaded by an admin and attached
 * to the car's trips by time.
 */
import { stopBoss } from '@carbooking/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, loginAs, MIN, north, prisma, seedBasics, type Client } from './helpers';

let app: FastifyInstance;
let s: Awaited<ReturnType<typeof seedBasics>>;
let admin: Client;
let jane: Client;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(async () => {
  await app.close();
  await stopBoss();
  await prisma.$disconnect();
});
beforeEach(async () => {
  s = await seedBasics();
  [admin, jane] = await Promise.all([s.admin, s.jane].map((u) => loginAs(app, u.id)));
});

/** Oversee's export: an HTML table, times in Kenya wall-clock (UTC+3). */
function overseeExport(rows: { at: Date; pos: { lat: number; lng: number } | null }[]) {
  const kenya = (d: Date) => new Date(d.getTime() + 180 * MIN).toISOString().slice(0, 19).replace('T', ' ');
  const tr = (cells: string[]) => `<tr>${cells.map((c) => `<td>\n  ${c}\n</td>`).join('')}</tr>`;
  const header = tr(['Date and Time', 'Coordinates/Address', 'Speed (Km/h)', 'Direction(°)', 'Ignition', 'Mileage (Km)', 'Data Type']);
  const body = rows.map((r) => tr([kenya(r.at), r.pos ? `${r.pos.lat},${r.pos.lng}` : 'Not Locate', '6', '0°', 'ON', '99436.479', 'GPS Location']));
  return `<html><head><meta http-equiv="content-type" content="application/vnd.ms-excel; charset=UTF-8"></head><body><table>${header}${body.join('')}</table></body></html>`;
}

async function upload(client: Client, carId: string, html: string) {
  const boundary = '----test';
  const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Location History Records Report.xls"\r\nContent-Type: application/vnd.ms-excel\r\n\r\n${html}\r\n--${boundary}--\r\n`;
  return app.inject({ method: 'POST', url: `/admin/cars/${carId}/tracker-history`, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${client.token}` } });
}

/** A finished hour-long trip in car 1, tracked by the phone with one fix. */
async function finishedTrip() {
  const startedAt = new Date(Math.floor((Date.now() - 3 * 3600_000) / 1000) * 1000);
  const endedAt = new Date(startedAt.getTime() + 60 * MIN);
  const booking = await prisma.booking.create({
    data: { ownerId: s.jane.id, driverId: s.driver.id, carId: s.car1.id, status: 'COMPLETED', startAt: startedAt, expectedReturnAt: endedAt },
  });
  const trip = await prisma.trip.create({
    data: { bookingId: booking.id, startedAt, endedAt, odometerStart: 10_000, odometerEnd: 10_006, photoStartKey: 'start.jpg', startRequestId: 'req-start', gpsDistanceKm: 2 },
  });
  await prisma.locationPoint.create({ data: { tripId: trip.id, recordedAt: new Date(startedAt.getTime() + 5 * MIN), ...north(5000), source: 'PHONE' } });
  return trip;
}

describe('tracker history upload', () => {
  it('attaches the fixes inside a trip, which then shows the tracker path and its distance', async () => {
    const trip = await finishedTrip();
    // A fix a minute from 30 min before the trip to 30 min after: parked, a 6 km drive north, parked.
    const rows: { at: Date; pos: { lat: number; lng: number } | null }[] = Array.from({ length: 121 }, (_, i) => {
      const m = i - 30;
      return { at: new Date(trip.startedAt.getTime() + m * MIN), pos: north(100 * Math.min(Math.max(m, 0), 60)) };
    });
    rows.splice(40, 0, { at: rows[40]!.at, pos: rows[40]!.pos }, { at: new Date(rows[40]!.at.getTime() + 1000), pos: null });

    const res = await upload(admin, s.car1.id, overseeExport(rows));
    expect(res.statusCode).toBe(200);
    // Inside the trip's window (a minute either side, as ingest keeps): minutes -1 to 61.
    expect(res.json()).toMatchObject({ fixes: 121, skipped: 1, duplicates: 1, outsideTrips: 121 - 63, trips: [{ tripId: trip.id, owner: 'Jane Mwangi', added: 63 }] });

    const detail = await admin.get(`/trips/${trip.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.pathSource).toBe('TRACKER');
    expect(detail.body.points).toHaveLength(63);
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).gpsDistanceKm).toBeCloseTo(6, 1);

    // The same file again adds nothing.
    const again = await upload(admin, s.car1.id, overseeExport(rows));
    expect(again.json().trips[0].added).toBe(0);
    expect(await prisma.locationPoint.count({ where: { tripId: trip.id, source: 'TRACKER' } })).toBe(63);
    expect(await prisma.auditLog.count({ where: { action: 'TRACKER_HISTORY_IMPORTED', entityId: s.car1.id } })).toBe(2);
  });

  it("leaves other cars' trips alone and turns away the wrong report", async () => {
    const trip = await finishedTrip();
    const rows = [{ at: new Date(trip.startedAt.getTime() + 10 * MIN), pos: north(1000) }];
    const other = await upload(admin, s.car2.id, overseeExport(rows));
    expect(other.json()).toMatchObject({ fixes: 1, trips: [], outsideTrips: 1 });
    expect((await admin.get(`/trips/${trip.id}`)).body.pathSource).toBe('PHONE');

    const wrong = await upload(admin, s.car1.id, '<table><tr><td>Time</td><td>Operation Type</td></tr></table>');
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe('BAD_TRACKER_FILE');

    expect((await upload(jane, s.car1.id, overseeExport(rows))).statusCode).toBe(403);
  });
});
