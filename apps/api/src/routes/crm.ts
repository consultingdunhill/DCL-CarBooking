import { DomainError, forbidden, notFound } from '@carbooking/core';
import { prisma } from '@carbooking/db';
import { crmEnabled, CrmUnavailable, ensureCrmProperties, fetchCrmLead, syncCrmProperties } from '@carbooking/server';
import type { FastifyInstance } from 'fastify';
import { isAdmin, me } from '../lib/auth';

const admin = { config: { auth: 'admin' as const } };

const unavailable = (err: unknown) =>
  err instanceof CrmUnavailable ? new DomainError('CRM_UNAVAILABLE', `${err.message}. Try again in a minute.`, 502) : err;

const sameEmail = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** The Dunhill CRM: "Book a car" on a lead there opens the booking form here. */
export async function crmRoutes(app: FastifyInstance) {
  /**
   * A lead's first name, agent and ticked listings, to fill in a booking. Staff only see
   * leads the CRM has assigned to them (matched by email); admins see any.
   */
  app.get<{ Params: { id: string } }>('/crm/leads/:id', async (req) => {
    const user = me(req);
    if (!crmEnabled()) throw notFound('The CRM link');
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound('Lead');

    const lead = await fetchCrmLead(id).catch((err) => {
      throw unavailable(err);
    });
    if (!lead) throw notFound('That lead');
    if (!isAdmin(req) && !sameEmail(lead.agent?.email, user.email)) {
      throw forbidden('This lead is not assigned to you in the CRM. Ask an admin to book it, or to assign it to you there.');
    }

    const properties = await ensureCrmProperties(lead.properties);
    const agentUser = lead.agent?.email
      ? await prisma.user.findFirst({ where: { email: { equals: lead.agent.email.trim(), mode: 'insensitive' }, active: true }, select: { id: true, name: true } })
      : null;

    return {
      ref: String(lead.id),
      firstName: lead.first_name,
      serviceType: lead.service_type,
      serviceLabel: lead.service_label,
      agent: lead.agent ? { name: lead.agent.full_name, userId: agentUser?.id ?? null } : null,
      properties: lead.properties.flatMap((p) => {
        const row = properties.get(p.ref);
        return row ? [{ id: row.id, ref: row.ref, address: row.address, lat: row.lat, lng: row.lng, service: row.service, title: p.title, directions: p.location_note }] : [];
      }),
    };
  });

  app.post('/admin/crm/sync', admin, async (req) => {
    if (!crmEnabled()) throw notFound('The CRM link');
    return syncCrmProperties(me(req).id).catch((err) => {
      throw unavailable(err);
    });
  });

  app.get('/admin/crm/last-sync', admin, async () => {
    const last = await prisma.auditLog.findFirst({ where: { action: 'CRM_PROPERTIES_SYNCED' }, orderBy: { at: 'desc' } });
    return { enabled: crmEnabled(), at: last?.at ?? null, summary: last?.after ?? null };
  });
}
