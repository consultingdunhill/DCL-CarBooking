import { ClientSchema, conflict, CRM_PROPERTY_PREFIX, forbidden, notFound, parsePortfolioRow, PORTFOLIO_TEMPLATE_HEADERS, PropertySchema } from '@carbooking/core';
import { isUniqueViolation, prisma, type Prisma } from '@carbooking/db';
import { audit, nearbyProperties, notify } from '@carbooking/server';
import type { FastifyInstance } from 'fastify';
import { isAdmin, me } from '../lib/auth';
import { csvTemplate, readCsvUpload } from '../lib/csv';
import { ipOf, parse, type IdParams } from '../lib/http';

/** Which unique field clashed, in words. */
function duplicateMessage(err: unknown): string {
  const target = String((err as { meta?: { target?: unknown } }).meta?.target ?? '');
  if (target.includes('crmRef') && (err as { meta?: { modelName?: string } }).meta?.modelName === 'Client') return 'A client with that CRM reference already exists';
  if (target.includes('crmRef')) return 'That CRM reference is already used by another property or client';
  return 'A property with that reference already exists';
}

const propertyInclude = { client: { select: { id: true, name: true, type: true, phone: true } }, createdBy: { select: { id: true, name: true } } } as const;

export async function propertyRoutes(app: FastifyInstance) {
  /** Search the portfolio by reference, CRM reference, address or client. */
  app.get<{ Querystring: { q?: string; status?: string; review?: string; limit?: string } }>('/properties', async (req) => {
    const q = req.query.q?.trim();
    const where: Prisma.PropertyWhereInput = {
      ...(q
        ? {
            OR: [
              { ref: { contains: q, mode: 'insensitive' } },
              { crmRef: { contains: q, mode: 'insensitive' } },
              { address: { contains: q, mode: 'insensitive' } },
              { client: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(req.query.status ? { status: { in: req.query.status.split(',') as never } } : {}),
      ...(req.query.review === '1' ? { needsReview: true } : {}),
    };
    return prisma.property.findMany({
      where,
      include: propertyInclude,
      orderBy: [{ status: 'asc' }, { ref: 'asc' }],
      take: Math.min(500, Number(req.query.limit) || 50),
    });
  });

  app.get<{ Querystring: { lat: string; lng: string } }>('/properties/nearby', async (req) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    return nearbyProperties(lat, lng);
  });

  app.get<{ Params: IdParams }>('/properties/:id', async (req) => {
    const p = await prisma.property.findUnique({ where: { id: req.params.id }, include: { ...propertyInclude, closures: { orderBy: { closedAt: 'desc' } } } });
    if (!p) throw notFound('Property');
    return p;
  });

  /** Staff can add a property (and its client) while booking; admins review new ones. */
  app.post('/properties', async (req, reply) => {
    const user = me(req);
    const body = parse(PropertySchema, req.body);
    const admin = isAdmin(req);
    const property = await prisma
      .$transaction(async (tx) => {
        let clientId = body.clientId ?? null;
        if (body.newClient) {
          const c = await tx.client.create({ data: body.newClient });
          clientId = c.id;
        }
        return tx.property.create({
          data: {
            ref: body.ref,
            crmRef: body.crmRef,
            address: body.address,
            lat: body.lat ?? null,
            lng: body.lng ?? null,
            clientId,
            service: body.service,
            status: body.status,
            createdById: user.id,
            needsReview: !admin,
          },
          include: propertyInclude,
        });
      })
      .catch((err) => {
        if (isUniqueViolation(err)) throw conflict('DUPLICATE', duplicateMessage(err));
        throw err;
      });
    await audit({ actorId: user.id, action: 'PROPERTY_CREATED', entity: 'Property', entityId: property.id, after: property, ip: ipOf(req) });
    if (!admin) {
      await notify({
        to: { admins: true },
        type: 'PROPERTY_ADDED',
        title: 'New property to review',
        body: `${user.name} added ${property.ref} · ${property.address}.`,
        link: '/admin/properties?review=1',
        channels: ['IN_APP'],
      });
    }
    reply.code(201);
    return property;
  });

  app.put<{ Params: IdParams }>('/properties/:id', { config: { auth: 'admin' } }, async (req) => {
    const body = parse(PropertySchema, req.body);
    const before = await prisma.property.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Property');
    // A CRM listing's pin is set by agents in the CRM and copied here; editing it here
    // would only be undone by the next sync.
    const pin = before.crmRef?.startsWith(CRM_PROPERTY_PREFIX) ? { lat: before.lat, lng: before.lng } : { lat: body.lat ?? null, lng: body.lng ?? null };
    const property = await prisma
      .$transaction(async (tx) => {
        const clientId = body.newClient ? (await tx.client.create({ data: body.newClient })).id : (body.clientId ?? null);
        return tx.property.update({
          where: { id: before.id },
          data: { ref: body.ref, crmRef: body.crmRef, address: body.address, ...pin, clientId, service: body.service, status: body.status, needsReview: false },
          include: propertyInclude,
        });
      })
      .catch((err) => {
        if (isUniqueViolation(err)) throw conflict('DUPLICATE', duplicateMessage(err));
        throw err;
      });
    await audit({ actorId: me(req).id, action: 'PROPERTY_UPDATED', entity: 'Property', entityId: property.id, before, after: property, ip: ipOf(req) });
    return property;
  });

  // ── Clients ─────────────────────────────────────────────────────────────────

  app.get<{ Querystring: { q?: string; limit?: string } }>('/clients', async (req) => {
    const q = req.query.q?.trim();
    return prisma.client.findMany({
      where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { crmRef: { contains: q, mode: 'insensitive' } }] } : {},
      orderBy: { name: 'asc' },
      take: Math.min(2000, Number(req.query.limit) || 200),
      include: { _count: { select: { properties: true } } },
    });
  });

  app.post('/clients', async (req) => {
    const client = await prisma.client.create({ data: parse(ClientSchema, req.body) }).catch((err) => {
      if (isUniqueViolation(err)) throw conflict('DUPLICATE', 'A client with that CRM reference already exists');
      throw err;
    });
    await audit({ actorId: me(req).id, action: 'CLIENT_CREATED', entity: 'Client', entityId: client.id, after: client, ip: ipOf(req) });
    return client;
  });

  app.put<{ Params: IdParams }>('/clients/:id', { config: { auth: 'admin' } }, async (req) => {
    const before = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Client');
    const client = await prisma.client.update({ where: { id: before.id }, data: parse(ClientSchema, req.body) }).catch((err) => {
      if (isUniqueViolation(err)) throw conflict('DUPLICATE', 'A client with that CRM reference already exists');
      throw err;
    });
    await audit({ actorId: me(req).id, action: 'CLIENT_UPDATED', entity: 'Client', entityId: client.id, before, after: client, ip: ipOf(req) });
    return client;
  });

  // ── Portfolio import (CSV, one-off and occasional refresh) ──────────────────

  app.get('/imports/templates/portfolio.csv', { config: { auth: 'admin' } }, async (_req, reply) => {
    reply.type('text/csv').header('Content-Disposition', 'attachment; filename="portfolio-template.csv"');
    return csvTemplate(PORTFOLIO_TEMPLATE_HEADERS);
  });

  app.post('/properties/import', { config: { auth: 'admin' } }, async (req) => {
    const user = me(req);
    if (!isAdmin(req)) throw forbidden();
    const { fileName, rows } = await readCsvUpload(req);
    const errors: { row: number; error: string }[] = [];
    let created = 0;
    let updated = 0;
    let clientsCreated = 0;

    for (const [i, raw] of rows.entries()) {
      const parsed = parsePortfolioRow(raw);
      if (!parsed.ok) {
        errors.push({ row: i + 2, error: parsed.error });
        continue;
      }
      const r = parsed.row;
      try {
        let clientId: string | null = null;
        if (r.client) {
          const existing = r.client.crmRef
            ? await prisma.client.findUnique({ where: { crmRef: r.client.crmRef } })
            : await prisma.client.findFirst({ where: { name: { equals: r.client.name, mode: 'insensitive' } } });
          if (existing) clientId = existing.id;
          else {
            clientId = (await prisma.client.create({ data: r.client })).id;
            clientsCreated++;
          }
        }
        const data = { crmRef: r.crmRef, address: r.address, service: r.service, status: r.status, lat: r.lat, lng: r.lng, clientId, needsReview: false };
        const existing = await prisma.property.findUnique({ where: { ref: r.ref } });
        if (existing) {
          await prisma.property.update({ where: { id: existing.id }, data: { ...data, lat: r.lat ?? existing.lat, lng: r.lng ?? existing.lng } });
          updated++;
        } else {
          await prisma.property.create({ data: { ...data, ref: r.ref, createdById: user.id } });
          created++;
        }
      } catch (err) {
        errors.push({ row: i + 2, error: isUniqueViolation(err) ? 'CRM reference already used by another property' : (err as Error).message });
      }
    }
    const summary = { fileName, rows: rows.length, created, updated, clientsCreated, errors: errors.slice(0, 200), errorCount: errors.length };
    await audit({ actorId: user.id, action: 'PORTFOLIO_IMPORTED', entity: 'Property', after: { ...summary, errors: undefined }, ip: ipOf(req) });
    return summary;
  });
}
