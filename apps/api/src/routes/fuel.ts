import { FuelEntrySchema, notFound, zonedTimeToUtc } from '@carbooking/core';
import { num, prisma, type FuelEntry, type Prisma } from '@carbooking/db';
import { audit, getSettings } from '@carbooking/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { me } from '../lib/auth';
import { ipOf, parse, type IdParams } from '../lib/http';
import { storage } from '../lib/storage';

const admin = { config: { auth: 'admin' as const } };
const dto = (f: FuelEntry & { car?: { registration: string }; enteredBy?: { name: string } }) => ({ ...f, litres: num(f.litres), amount: num(f.amount) });

export async function fuelRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { carId?: string; from?: string; to?: string } }>('/admin/fuel', admin, async (req) => {
    const where: Prisma.FuelEntryWhereInput = {
      ...(req.query.carId ? { carId: req.query.carId } : {}),
      ...(req.query.from || req.query.to
        ? { date: { ...(req.query.from ? { gte: new Date(req.query.from) } : {}), ...(req.query.to ? { lt: new Date(req.query.to) } : {}) } }
        : {}),
    };
    const rows = await prisma.fuelEntry.findMany({
      where,
      orderBy: { date: 'desc' },
      take: 5000,
      include: { car: { select: { registration: true } }, enteredBy: { select: { name: true } } },
    });
    return rows.map(dto);
  });

  async function save(req: FastifyRequest, id?: string) {
    const user = me(req);
    const body = parse(FuelEntrySchema, req.body);
    const s = await getSettings();
    // A monthly entry is dated on the 1st so it lands in the right month.
    const dateKey = body.type === 'MONTHLY' ? `${body.date.slice(0, 7)}-01` : body.date;
    const data = {
      carId: body.carId,
      type: body.type,
      date: zonedTimeToUtc(dateKey, '12:00', s.timezone),
      litres: body.litres,
      amount: body.amount,
      currency: body.currency ?? s.currency,
      odometer: body.odometer ?? null,
      receiptKey: body.receiptKey ?? null,
      notes: body.notes,
    };
    if (data.receiptKey && !(await storage.exists(data.receiptKey))) data.receiptKey = null;
    const before = id ? await prisma.fuelEntry.findUnique({ where: { id } }) : null;
    if (id && !before) throw notFound('Fuel entry');
    const entry = id ? await prisma.fuelEntry.update({ where: { id }, data }) : await prisma.fuelEntry.create({ data: { ...data, enteredById: user.id } });
    await audit({ actorId: user.id, action: id ? 'FUEL_UPDATED' : 'FUEL_CREATED', entity: 'FuelEntry', entityId: entry.id, before: before && dto(before), after: dto(entry), ip: ipOf(req) });
    return dto(entry);
  }

  app.post('/admin/fuel', admin, (req) => save(req));
  app.put<{ Params: IdParams }>('/admin/fuel/:id', admin, (req) => save(req, req.params.id));

  app.delete<{ Params: IdParams }>('/admin/fuel/:id', admin, async (req) => {
    const before = await prisma.fuelEntry.delete({ where: { id: req.params.id } });
    await audit({ actorId: me(req).id, action: 'FUEL_DELETED', entity: 'FuelEntry', entityId: before.id, before: dto(before), ip: ipOf(req) });
    return { ok: true };
  });

  app.get<{ Params: IdParams }>('/admin/fuel/:id/receipt', admin, async (req) => {
    const f = await prisma.fuelEntry.findUnique({ where: { id: req.params.id } });
    if (!f?.receiptKey) throw notFound('Receipt');
    return { url: await storage.readUrl(f.receiptKey) };
  });
}
