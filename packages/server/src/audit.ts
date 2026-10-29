import { prisma, type Prisma } from '@carbooking/db';

type Tx = Prisma.TransactionClient | typeof prisma;

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

/** Append to the audit log. Every admin decision and location view goes here. */
export async function audit(entry: AuditEntry, tx: Tx = prisma): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: json(entry.before),
      after: json(entry.after),
      ip: entry.ip ?? null,
    },
  });
}

const recentViews = new Map<string, number>();
const VIEW_WINDOW_MS = 15 * 60_000;

/**
 * Log that an admin viewed location data. Screens refresh every few seconds,
 * so repeat views of the same thing within 15 minutes are logged once.
 */
export async function auditView(entry: AuditEntry): Promise<void> {
  const key = `${entry.actorId}|${entry.action}|${entry.entityId ?? ''}`;
  const last = recentViews.get(key);
  if (last && Date.now() - last < VIEW_WINDOW_MS) return;
  recentViews.set(key, Date.now());
  if (recentViews.size > 5000) recentViews.clear();
  await audit(entry);
}
