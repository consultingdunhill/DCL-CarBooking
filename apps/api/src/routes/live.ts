import { prisma } from '@carbooking/db';
import { auditView, subscribeLive, type LiveEvent } from '@carbooking/server';
import type { FastifyInstance } from 'fastify';
import { me } from '../lib/auth';
import { ipOf } from '../lib/http';
import { getOffice } from '../services/bookings';

type Listener = { userId: string; admin: boolean; send: (e: LiveEvent) => void };
const listeners = new Set<Listener>();
let unsubscribe: (() => void) | null = null;

/** One LISTEN connection per API process, fanned out to connected browsers. */
function ensureSubscribed() {
  if (unsubscribe) return;
  unsubscribe = subscribeLive((event) => {
    for (const l of listeners) {
      // Location updates are for admins only; staff get their own notifications and booking changes.
      if (event.type === 'trip.updated' && !l.admin) continue;
      if (event.type === 'notification' && event.userId !== l.userId) continue;
      l.send(event);
    }
  });
}

export async function liveRoutes(app: FastifyInstance) {
  app.addHook('onClose', async () => {
    unsubscribe?.();
    unsubscribe = null;
  });

  /** Server-sent events. The web app reads it with fetch so it can send the bearer token. */
  app.get('/live/stream', async (req, reply) => {
    const user = me(req);
    ensureSubscribed();
    // hijack() skips Fastify's reply pipeline, so carry over headers set so far (CORS).
    const headers = Object.fromEntries(Object.entries(reply.getHeaders()).filter(([, v]) => v !== undefined)) as Record<string, string | string[] | number>;
    reply.hijack();
    reply.raw.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: ready\ndata: {}\n\n`);
    const listener: Listener = {
      userId: user.id,
      admin: user.role === 'ADMIN',
      send: (e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`),
    };
    listeners.add(listener);
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      listeners.delete(listener);
    });
  });

  /** Everything the admin live map needs in one call. */
  app.get('/live/snapshot', { config: { auth: 'admin' } }, async (req) => {
    const user = me(req);
    const [office, cars, active] = await Promise.all([
      getOffice(),
      prisma.car.findMany({ where: { status: { not: 'RETIRED' } }, orderBy: { registration: 'asc' } }),
      prisma.booking.findMany({
        where: { status: { in: ['IN_PROGRESS', 'AWAITING_ODOMETER'] } },
        include: {
          owner: { select: { id: true, name: true, phone: true } },
          car: { select: { id: true, registration: true, make: true, model: true } },
          stops: { where: { status: { in: ['PLANNED', 'ARRIVED', 'DEPARTED', 'SKIPPED'] } }, orderBy: { seq: 'asc' }, select: { id: true, seq: true, address: true, label: true, lat: true, lng: true, status: true, arrivedAt: true, departedAt: true } },
          passengers: { select: { user: { select: { id: true, name: true } } } },
          trip: true,
        },
        orderBy: { startAt: 'asc' },
      }),
    ]);
    if (active.length) await auditView({ actorId: user.id, action: 'VIEW_LIVE_MAP', entity: 'Trip', entityId: null, after: { trips: active.map((b) => b.trip?.id) }, ip: ipOf(req) });
    const out = new Set(active.map((b) => b.carId));
    return {
      office,
      cars: cars.map((c) => ({ ...c, out: out.has(c.id) })),
      trips: active.map((b) => ({
        bookingId: b.id,
        status: b.status,
        startAt: b.startAt,
        expectedReturnAt: b.expectedReturnAt,
        plannedPolyline: b.plannedPolyline,
        owner: b.owner,
        car: b.car,
        stops: b.stops,
        passengers: b.passengers.map((p) => p.user),
        trip: b.trip,
      })),
    };
  });
}
