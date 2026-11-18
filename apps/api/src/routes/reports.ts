import {
  addDaysToDateKey,
  buildReport,
  REPORT_META,
  ReportIdSchema,
  ReportQuerySchema,
  reportToCsv,
  zonedTimeToUtc,
  type ReportResult,
} from '@carbooking/core';
import { audit, getSettings, loadDataset } from '@carbooking/server';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { me } from '../lib/auth';
import { ipOf, parse } from '../lib/http';

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
