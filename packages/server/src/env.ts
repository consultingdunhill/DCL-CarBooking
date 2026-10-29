import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/** Find the repo root and load its .env (without overriding real environment variables). */
function loadRootEnv(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      if (existsSync(join(dir, '.env'))) loadDotenv({ path: join(dir, '.env'), quiet: true });
      return dir;
    }
    dir = resolve(dir, '..');
    if (dir === dirname(dir)) break;
  }
  return process.cwd();
}
export const repoRoot = loadRootEnv();

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opt = z.preprocess(blankToUndefined, z.string().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().default(4000),
  APP_URL: z.string().default('http://localhost:5173'),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  APP_SECRET: z.string().min(16, 'APP_SECRET must be at least 16 characters'),

  AUTH_MODE: z.enum(['entra', 'dev']).default('dev'),
  ENTRA_TENANT_ID: opt,
  ENTRA_API_AUDIENCE: opt,
  ENTRA_ADMIN_ROLE: z.string().default('Admin'),
  ENTRA_STAFF_ROLE: z.string().default('Staff'),

  GOOGLE_MAPS_SERVER_KEY: opt,

  STORAGE_DRIVER: z.enum(['local', 'azure']).default('local'),
  STORAGE_LOCAL_DIR: opt,
  AZURE_STORAGE_ACCOUNT: opt,
  AZURE_STORAGE_KEY: opt,
  AZURE_STORAGE_CONTAINER: z.string().default('carbooking'),

  VAPID_PUBLIC_KEY: opt,
  VAPID_PRIVATE_KEY: opt,
  VAPID_SUBJECT: z.string().default('mailto:fleet@example.co.ke'),
  FCM_SERVICE_ACCOUNT_BASE64: opt,
  GRAPH_TENANT_ID: opt,
  GRAPH_CLIENT_ID: opt,
  GRAPH_CLIENT_SECRET: opt,
  GRAPH_SENDER: opt,
  SMS_PROVIDER: z.enum(['africastalking', 'twilio', 'none']).default('none'),
  AFRICASTALKING_USERNAME: opt,
  AFRICASTALKING_API_KEY: opt,
  AFRICASTALKING_SENDER_ID: opt,
  TWILIO_ACCOUNT_SID: opt,
  TWILIO_AUTH_TOKEN: opt,
  TWILIO_SMS_FROM: opt,
  TWILIO_WHATSAPP_FROM: opt,
  /** baileys = a linked WhatsApp device (QR scan); twilio = WhatsApp Business API via Twilio. */
  WHATSAPP_PROVIDER: z.enum(['baileys', 'twilio', 'none']).default('none'),
  WHATSAPP_AUTH_DIR: opt,
  /** Optional: link with a pairing code for this number instead of scanning a QR. */
  WHATSAPP_PAIRING_NUMBER: opt,

  /** The Dunhill CRM; both blank turns the link off. On the shared server, its internal URL. */
  CRM_API_URL: z.preprocess(blankToUndefined, z.url().optional()),
  /** The CRM's FLEET_INTEGRATION_TOKEN. */
  CRM_API_TOKEN: z.preprocess(blankToUndefined, z.string().min(32, 'CRM_API_TOKEN must be at least 32 characters').optional()),
});

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'dev') {
    throw new Error('AUTH_MODE=dev is not allowed in production');
  }
  if (env.AUTH_MODE === 'entra' && (!env.ENTRA_TENANT_ID || !env.ENTRA_API_AUDIENCE)) {
    throw new Error('AUTH_MODE=entra needs ENTRA_TENANT_ID and ENTRA_API_AUDIENCE');
  }
  return env;
}

export const env = parseEnv();

/** node-postgres doesn't understand Prisma's ?schema= parameter. */
export function pgConnectionString(url = env.DATABASE_URL): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}
