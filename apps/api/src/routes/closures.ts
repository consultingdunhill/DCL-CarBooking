import {
  CLOSURE_TEMPLATE_HEADERS,
  conflict,
  matchClosureRow,
  notFound,
  parseClosureRow,
  ResolveClosureRowSchema,
  zonedTimeToUtc,
  type DealType,
} from '@carbooking/core';
import { num, prisma, type Prisma } from '@carbooking/db';
import { audit, getSettings } from '@carbooking/server';
import type { FastifyInstance } from 'fastify';
import { me } from '../lib/auth';
import { csvTemplate, readCsvUpload } from '../lib/csv';
import { ipOf, parse, type IdParams } from '../lib/http';

const admin = { config: { auth: 'admin' as const } };

/** A closure sets the property's status: sold or let. */
const statusFor = (deal: DealType) => (deal === 'SALE' ? 'SOLD' : 'LET');

export async function closureRoutes(app: FastifyInstance) {
  app.get('/imports/templates/closures.csv', admin, async (_req, reply) => {
    reply.type('text/csv').header('Content-Disposition', 'attachment; filename="closures-template.csv"');
    return csvTemplate(CLOSURE_TEMPLATE_HEADERS);
  });

  /**
   * Upload the CRM's closures export. Rows are matched to properties by CRM
   * reference and to staff by email; anything unmatched waits in the review queue.
   */
  app.post('/admin/closures/import', admin, async (req) => {
    const user = me(req);
    const { fileName, rows } = await readCsvUpload(req);
    const [properties, users] = await Promise.all([
      prisma.property.findMany({ where: { crmRef: { not: null } }, select: { id: true, crmRef: true } }),
      prisma.user.findMany({ select: { id: true, email: true } }),
    ]);
    const byCrm = new Map(properties.map((p) => [p.crmRef!.toLowerCase(), { id: p.id }]));
    const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), { id: u.id }]));
    const { timezone } = await getSettings();

    const batch = await prisma.closureImportBatch.create({
      data: { fileName, uploadedById: user.id, rowCount: rows.length, matchedCount: 0, unmatchedCount: 0 },
    });
    let matched = 0;
    let unmatched = 0;
    let duplicates = 0;

    for (const [i, raw] of rows.entries()) {
      const row = parseClosureRow(raw);
      const m = matchClosureRow(row, byCrm, byEmail);
      const base = { batchId: batch.id, rowNumber: i + 2, raw: raw as Prisma.InputJsonValue };
      if (row.dealRef && (await prisma.closure.findUnique({ where: { crmRef: row.dealRef } }))) {
        duplicates++;
        await prisma.closureImportRow.create({ data: { ...base, status: 'DUPLICATE', problems: ['Already imported'] } });
        continue;
      }
      if (m.status === 'UNMATCHED') {
        unmatched++;
        await prisma.closureImportRow.create({ data: { ...base, status: 'UNMATCHED', problems: m.problems } });
        continue;
      }
      // Dates in the CSV are calendar days in local time.
      const closedAt = zonedTimeToUtc(row.closedAt!.toISOString().slice(0, 10), '12:00', timezone);
      const closure = await prisma.closure.create({
        data: { propertyId: m.propertyId!, staffId: m.staffId, closedAt, dealType: row.dealType!, fee: row.fee, crmRef: row.dealRef, importBatchId: batch.id },
      });
      await prisma.property.update({ where: { id: m.propertyId! }, data: { status: statusFor(row.dealType!) } });
      await prisma.closureImportRow.create({ data: { ...base, status: 'MATCHED', problems: [], closureId: closure.id } });
      matched++;
    }
    const result = await prisma.closureImportBatch.update({
      where: { id: batch.id },
      data: { matchedCount: matched, unmatchedCount: unmatched, duplicateCount: duplicates },
    });
    await audit({ actorId: user.id, action: 'CLOSURES_IMPORTED', entity: 'ClosureImportBatch', entityId: batch.id, after: result, ip: ipOf(req) });
    return result;
  });

  app.get('/admin/closures/batches', admin, async () =>
    prisma.closureImportBatch.findMany({ orderBy: { uploadedAt: 'desc' }, take: 50, include: { uploadedBy: { select: { name: true } } } }),
  );

  /** The review queue: rows that couldn't be matched automatically. */
  app.get('/admin/closures/review', admin, async () =>
    prisma.closureImportRow.findMany({
      where: { status: 'UNMATCHED' },
      orderBy: [{ createdAt: 'desc' }, { rowNumber: 'asc' }],
      include: { batch: { select: { fileName: true, uploadedAt: true } } },
    }),
  );

  app.post<{ Params: IdParams }>('/admin/closures/rows/:id/resolve', admin, async (req) => {
    const user = me(req);
    const body = parse(ResolveClosureRowSchema, req.body);
    const row = await prisma.closureImportRow.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('Import row');
    if (row.status !== 'UNMATCHED') throw conflict('ALREADY_RESOLVED', 'This row has already been dealt with');

    if ('ignore' in body) {
      await prisma.closureImportRow.update({ where: { id: row.id }, data: { status: 'IGNORED' } });
      await audit({ actorId: user.id, action: 'CLOSURE_ROW_IGNORED', entity: 'ClosureImportRow', entityId: row.id, ip: ipOf(req) });
      return { ok: true };
    }
    const parsed = parseClosureRow(row.raw as Record<string, string>);
    const dealType = body.dealType ?? parsed.dealType;
    const day = body.closedAt ?? parsed.closedAt?.toISOString().slice(0, 10);
    if (!dealType || !day) throw conflict('INCOMPLETE', 'Give the closing date and deal type');
    const { timezone } = await getSettings();
    const closure = await prisma.$transaction(async (tx) => {
      const c = await tx.closure.create({
        data: {
          propertyId: body.propertyId,
          staffId: body.staffId,
          closedAt: zonedTimeToUtc(day, '12:00', timezone),
          dealType,
          fee: body.fee ?? parsed.fee,
          crmRef: parsed.dealRef,
          importBatchId: row.batchId,
        },
      });
      await tx.property.update({ where: { id: body.propertyId }, data: { status: statusFor(dealType) } });
      await tx.closureImportRow.update({ where: { id: row.id }, data: { status: 'RESOLVED', closureId: c.id } });
      return c;
    });
    await audit({ actorId: user.id, action: 'CLOSURE_ROW_RESOLVED', entity: 'ClosureImportRow', entityId: row.id, after: closure, ip: ipOf(req) });
    return { ...closure, fee: num(closure.fee) };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/admin/closures', admin, async (req) => {
    const rows = await prisma.closure.findMany({
      where: req.query.from || req.query.to ? { closedAt: { ...(req.query.from ? { gte: new Date(req.query.from) } : {}), ...(req.query.to ? { lt: new Date(req.query.to) } : {}) } } : {},
      orderBy: { closedAt: 'desc' },
      take: 500,
      include: { property: { select: { id: true, ref: true, address: true } }, staff: { select: { id: true, name: true } } },
    });
    return rows.map((c) => ({ ...c, fee: num(c.fee) }));
  });
}
