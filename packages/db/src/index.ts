import { Prisma, PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/** Postgres raised an exclusion-constraint violation (double booking). */
export function isExclusionViolation(err: unknown, constraint?: string): boolean {
  const text = errorText(err);
  if (!text.includes('23P01') && !text.includes('conflicting key value violates exclusion constraint')) return false;
  return constraint ? text.includes(constraint) : true;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function errorText(err: unknown): string {
  if (!err) return '';
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.code} ${err.message} ${JSON.stringify(err.meta ?? {})}`;
  if (err instanceof Error) return `${err.message} ${(err as { code?: string }).code ?? ''}`;
  return String(err);
}

/** Decimal | number | null → number | null. */
export function num(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : v.toNumber();
}

export const CAR_OVERLAP_CONSTRAINT = 'booking_car_no_overlap';
export const DRIVER_OVERLAP_CONSTRAINT = 'booking_driver_no_overlap';
