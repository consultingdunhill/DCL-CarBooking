import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

/** Validate input with a shared schema. A ZodError becomes a 400 in the error handler. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  return schema.parse(data ?? {});
}

export const ipOf = (req: FastifyRequest) => req.ip;

export type IdParams = { id: string };
