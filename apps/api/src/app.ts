import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { DomainError } from '@carbooking/core';
import { isExclusionViolation, Prisma } from '@carbooking/db';
import { env } from '@carbooking/server';
import Fastify, { type FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { authPlugin } from './lib/auth';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { bookingRoutes } from './routes/bookings';
import { closureRoutes } from './routes/closures';
import { crmRoutes } from './routes/crm';
import { fuelRoutes } from './routes/fuel';
import { liveRoutes } from './routes/live';
import { notificationRoutes } from './routes/notifications';
import { propertyRoutes } from './routes/properties';
import { reportRoutes } from './routes/reports';
import { tripRoutes } from './routes/trips';
import { uploadRoutes } from './routes/uploads';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: env.NODE_ENV === 'production' ? 'info' : 'warn' },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(multipart);
  await app.register(authPlugin);

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? `${first.path.join('.')}: ` : '';
      return reply.code(400).send({ error: { code: 'VALIDATION', message: `${where}${first?.message ?? 'Invalid input'}`, details: err.issues } });
    }
    if (isExclusionViolation(err)) {
      return reply.code(409).send({ error: { code: 'SLOT_TAKEN', message: 'Another approved trip already holds this car or the driver at that time' } });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: { code: (err as FastifyError).code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
  });

  app.get('/health', { config: { auth: 'public' } }, async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(bookingRoutes);
  await app.register(tripRoutes);
  await app.register(liveRoutes);
  await app.register(uploadRoutes);
  await app.register(propertyRoutes);
  await app.register(fuelRoutes);
  await app.register(closureRoutes);
  await app.register(crmRoutes);
  await app.register(reportRoutes);
  await app.register(notificationRoutes);
  return app;
}
