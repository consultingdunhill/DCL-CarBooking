import {
  CarSchema,
  conflict,
  DomainError,
  DriverSchema,
  HourlyRateSchema,
  JobRoleSchema,
  notFound,
  OfficeSchema,
  ReorderSchema,
  SettingsUpdateSchema,
  UserUpdateSchema,
  VisitReasonSchema,
  zonedTimeToUtc,
} from '@carbooking/core';
import { isUniqueViolation, num, prisma, type Prisma } from '@carbooking/db';
import { audit, env, getSettings, invalidateSettings } from '@carbooking/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { me } from '../lib/auth';
import { ipOf, parse, type IdParams } from '../lib/http';

const admin = { config: { auth: 'admin' as const } };

async function logChange(req: FastifyRequest, action: string, entity: string, entityId: string | null, before: unknown, after: unknown) {
  await audit({ actorId: me(req).id, action, entity, entityId, before, after, ip: ipOf(req) });
}

function duplicate(err: unknown, what: string): never {
  if (isUniqueViolation(err)) throw conflict('DUPLICATE', `${what} already exists`);
  throw err;
}

export async function adminRoutes(app: FastifyInstance) {
  /** Reference data every signed-in user needs (booking form, map). */
  app.get('/reference', async () => {
    const [offices, cars, reasons, drivers, settings] = await Promise.all([
      prisma.office.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.car.findMany({ where: { status: { not: 'RETIRED' } }, orderBy: { registration: 'asc' } }),
      prisma.visitReason.findMany({ where: { active: true }, orderBy: [{ department: 'asc' }, { sortOrder: 'asc' }] }),
      prisma.driver.findMany({ where: { active: true }, select: { id: true, name: true, phone: true } }),
      getSettings(),
    ]);
    return {
      office: offices[0] ?? null,
      cars,
      reasons,
      drivers,
      settings: {
        currency: settings.currency,
        timezone: settings.timezone,
        startWindowMin: settings.startWindowMin,
        noShowWindowMin: settings.noShowWindowMin,
        overdueGraceMin: settings.overdueGraceMin,
        workingHours: settings.workingHours,
        privacyNoticeVersion: settings.privacyNoticeVersion,
      },
      features: { googleRoutes: Boolean(env.GOOGLE_MAPS_SERVER_KEY), authMode: env.AUTH_MODE },
    };
  });

  // ── Cars ────────────────────────────────────────────────────────────────────

  app.get('/admin/cars', admin, async () => prisma.car.findMany({ orderBy: { registration: 'asc' }, include: { homeOffice: { select: { id: true, name: true } } } }));

  app.post('/admin/cars', admin, async (req) => {
    const body = parse(CarSchema, req.body);
    const homeOfficeId = body.homeOfficeId ?? (await prisma.office.findFirst({ orderBy: { createdAt: 'asc' } }))?.id ?? null;
    const car = await prisma.car.create({ data: { ...body, homeOfficeId } }).catch((e) => duplicate(e, 'A car with that registration'));
    await logChange(req, 'CAR_CREATED', 'Car', car.id, null, car);
    return car;
  });

  app.put<{ Params: IdParams }>('/admin/cars/:id', admin, async (req) => {
    const body = parse(CarSchema, req.body);
    const before = await prisma.car.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Car');
    const car = await prisma.car.update({ where: { id: before.id }, data: body }).catch((e) => duplicate(e, 'A car with that registration'));
    await logChange(req, 'CAR_UPDATED', 'Car', car.id, before, car);
    return car;
  });

  // ── Driver(s) ───────────────────────────────────────────────────────────────

  app.get('/admin/drivers', admin, async () => prisma.driver.findMany({ orderBy: { name: 'asc' } }));

  app.post('/admin/drivers', admin, async (req) => {
    const driver = await prisma.driver.create({ data: parse(DriverSchema, req.body) });
    await logChange(req, 'DRIVER_CREATED', 'Driver', driver.id, null, driver);
    return driver;
  });

  app.put<{ Params: IdParams }>('/admin/drivers/:id', admin, async (req) => {
    const body = parse(DriverSchema, req.body);
    const before = await prisma.driver.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Driver');
    const driver = await prisma.driver.update({ where: { id: before.id }, data: body });
    await logChange(req, 'DRIVER_UPDATED', 'Driver', driver.id, before, driver);
    return driver;
  });

  // ── Visit reasons ───────────────────────────────────────────────────────────

  app.get('/admin/reasons', admin, async () =>
    prisma.visitReason.findMany({ orderBy: [{ active: 'desc' }, { department: 'asc' }, { sortOrder: 'asc' }], include: { _count: { select: { stops: true } } } }),
  );

  app.post('/admin/reasons', admin, async (req) => {
    const body = parse(VisitReasonSchema, req.body);
    const max = await prisma.visitReason.aggregate({ _max: { sortOrder: true }, where: { department: body.department } });
    const reason = await prisma.visitReason.create({ data: { ...body, sortOrder: body.sortOrder ?? (max._max.sortOrder ?? 0) + 1 } });
    await logChange(req, 'REASON_CREATED', 'VisitReason', reason.id, null, reason);
    return reason;
  });

  // Archived reasons (active=false) stay in history and reports.
  app.put<{ Params: IdParams }>('/admin/reasons/:id', admin, async (req) => {
    const body = parse(VisitReasonSchema, req.body);
    const before = await prisma.visitReason.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Reason');
    // Leaving `active` out keeps the current state instead of un-archiving.
    if ((req.body as { active?: unknown } | null)?.active === undefined) body.active = before.active;
    const reason = await prisma.visitReason.update({ where: { id: before.id }, data: body });
    await logChange(req, before.active && !body.active ? 'REASON_ARCHIVED' : 'REASON_UPDATED', 'VisitReason', reason.id, before, reason);
    return reason;
  });

  app.post('/admin/reasons/reorder', admin, async (req) => {
    const { ids } = parse(ReorderSchema, req.body);
    await prisma.$transaction(ids.map((id, i) => prisma.visitReason.update({ where: { id }, data: { sortOrder: i } })));
    return { ok: true };
  });

  // ── Office ──────────────────────────────────────────────────────────────────

  app.get('/admin/office', admin, async () => prisma.office.findFirst({ orderBy: { createdAt: 'asc' } }));

  app.put('/admin/office', admin, async (req) => {
    const body = parse(OfficeSchema, req.body);
    if (body.wakeupRadiusM <= body.arrivalRadiusM) throw new DomainError('INVALID_RADIUS', 'The wake-up geofence must be larger than the arrival zone');
    const before = await prisma.office.findFirst({ orderBy: { createdAt: 'asc' } });
    const office = before ? await prisma.office.update({ where: { id: before.id }, data: body }) : await prisma.office.create({ data: body });
    await logChange(req, 'OFFICE_UPDATED', 'Office', office.id, before, office);
    return office;
  });

  // ── Job roles & hourly rates ────────────────────────────────────────────────

  app.get('/admin/job-roles', admin, async () => prisma.jobRole.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { users: true } } } }));

  app.post('/admin/job-roles', admin, async (req) => {
    const role = await prisma.jobRole.create({ data: parse(JobRoleSchema, req.body) }).catch((e) => duplicate(e, 'That job role'));
    await logChange(req, 'JOB_ROLE_CREATED', 'JobRole', role.id, null, role);
    return role;
  });

  app.put<{ Params: IdParams }>('/admin/job-roles/:id', admin, async (req) => {
    const before = await prisma.jobRole.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Job role');
    const role = await prisma.jobRole.update({ where: { id: before.id }, data: parse(JobRoleSchema, req.body) }).catch((e) => duplicate(e, 'That job role'));
    await logChange(req, 'JOB_ROLE_UPDATED', 'JobRole', role.id, before, role);
    return role;
  });

  app.get('/admin/rates', admin, async () => {
    const rates = await prisma.hourlyRate.findMany({ orderBy: [{ forDriver: 'desc' }, { effectiveFrom: 'desc' }], include: { jobRole: { select: { id: true, name: true } } } });
    return rates.map((r) => ({ ...r, rate: num(r.rate) }));
  });

  // Rates are dated: a new rate applies from its date, earlier trips keep the old one.
  app.post('/admin/rates', admin, async (req) => {
    const body = parse(HourlyRateSchema, req.body);
    const { timezone } = await getSettings();
    const rate = await prisma.hourlyRate.create({
      data: { jobRoleId: body.forDriver ? null : body.jobRoleId, forDriver: body.forDriver, rate: body.rate, effectiveFrom: zonedTimeToUtc(body.effectiveFrom, '00:00', timezone) },
    });
    await logChange(req, 'RATE_CREATED', 'HourlyRate', rate.id, null, { ...rate, rate: num(rate.rate) });
    return { ...rate, rate: num(rate.rate) };
  });

  app.delete<{ Params: IdParams }>('/admin/rates/:id', admin, async (req) => {
    const before = await prisma.hourlyRate.delete({ where: { id: req.params.id } });
    await logChange(req, 'RATE_DELETED', 'HourlyRate', before.id, { ...before, rate: num(before.rate) }, null);
    return { ok: true };
  });

  // ── Users ───────────────────────────────────────────────────────────────────

  app.get('/admin/users', admin, async () =>
    prisma.user.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, email: true, phone: true, role: true, department: true, active: true, lastLoginAt: true, privacyAckAt: true, entraOid: true, jobRole: { select: { id: true, name: true } } },
    }),
  );

  app.patch<{ Params: IdParams }>('/admin/users/:id', admin, async (req) => {
    const body = parse(UserUpdateSchema, req.body);
    // With Entra ID, roles and access come from Microsoft 365 app roles.
    if (env.AUTH_MODE === 'entra' && (body.role !== undefined || body.active !== undefined)) {
      throw new DomainError('MANAGED_IN_ENTRA', 'Roles and access are managed in Microsoft 365 (Entra app roles)', 409);
    }
    const before = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('User');
    const user = await prisma.user.update({ where: { id: before.id }, data: body });
    await logChange(req, 'USER_UPDATED', 'User', user.id, { role: before.role, department: before.department, jobRoleId: before.jobRoleId, phone: before.phone }, body);
    return user;
  });

  // ── Settings ────────────────────────────────────────────────────────────────

  app.get('/admin/settings', admin, async () => getSettings());

  app.patch('/admin/settings', admin, async (req) => {
    const body = parse(SettingsUpdateSchema, req.body);
    const before = await getSettings();
    const next = { ...before, ...body };
    if (next.trackingLostThresholdMin <= next.offlineThresholdMin) {
      throw new DomainError('INVALID_SETTINGS', '"Tracking lost after" must be longer than "Offline after"');
    }
    if (next.lowBatteryPct < next.deadBatteryPct) throw new DomainError('INVALID_SETTINGS', 'The low-battery level must be at least the dead-battery level');
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: body.timezone });
      } catch {
        throw new DomainError('INVALID_SETTINGS', `Unknown timezone "${body.timezone}"`);
      }
    }
    for (const [day, windows] of next.workingHours.entries()) {
      if (windows.some(([from, to]) => to <= from)) throw new DomainError('INVALID_SETTINGS', `Working hours on day ${day} close before they open`);
    }
    const user = me(req);
    await prisma.$transaction(
      Object.entries(body).map(([key, value]) =>
        prisma.setting.upsert({
          where: { key },
          create: { key, value: value as Prisma.InputJsonValue, updatedById: user.id },
          update: { value: value as Prisma.InputJsonValue, updatedById: user.id },
        }),
      ),
    );
    invalidateSettings();
    const after = await getSettings();
    await logChange(req, 'SETTINGS_UPDATED', 'Setting', null, Object.fromEntries(Object.keys(body).map((k) => [k, before[k as keyof typeof before]])), body);
    return after;
  });

  // ── Audit log ───────────────────────────────────────────────────────────────

  app.get<{ Querystring: { entity?: string; entityId?: string; action?: string; limit?: string } }>('/admin/audit', admin, async (req) =>
    prisma.auditLog.findMany({
      where: {
        ...(req.query.entity ? { entity: req.query.entity } : {}),
        ...(req.query.entityId ? { entityId: req.query.entityId } : {}),
        ...(req.query.action ? { action: req.query.action } : {}),
      },
      orderBy: { at: 'desc' },
      take: Math.min(500, Number(req.query.limit) || 100),
      include: { actor: { select: { id: true, name: true } } },
    }),
  );
}
