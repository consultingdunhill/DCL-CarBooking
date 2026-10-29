/**
 * WhatsApp alerts through a linked device (Baileys), instead of a paid API.
 *
 * The worker holds one WhatsApp Web session for a company number: an admin
 * links it once by scanning a QR code (Admin → Office & settings), like
 * WhatsApp Web. The session is stored in WHATSAPP_AUTH_DIR and reconnects on
 * restart. Only the worker sends; the API reads the status the worker saves.
 *
 * This is an unofficial client: WhatsApp can ban numbers that use it, so use a
 * dedicated company number and keep it to urgent alerts.
 */
import { rm } from 'node:fs/promises';
import { toE164 } from '@carbooking/core';
import { prisma, type Prisma } from '@carbooking/db';
import { env, repoRoot } from './env';

export interface WhatsappStatus {
  state: 'disabled' | 'connecting' | 'waiting_for_scan' | 'connected' | 'logged_out' | 'error';
  /** The linked company number, when connected. */
  number?: string | null;
  /** QR code to scan, as a data URL (while waiting for a scan). */
  qr?: string | null;
  /** Pairing code alternative to the QR (when WHATSAPP_PAIRING_NUMBER is set). */
  pairingCode?: string | null;
  error?: string | null;
  updatedAt: string;
}

export const WHATSAPP_STATUS_KEY = 'whatsapp.status';
const authDir = () => env.WHATSAPP_AUTH_DIR ?? `${repoRoot}/.whatsapp-auth`;

// Baileys is loaded lazily so the API process never pulls it in.
type Baileys = typeof import('@whiskeysockets/baileys');
type Socket = ReturnType<Baileys['makeWASocket']>;

let sock: Socket | null = null;
let current: WhatsappStatus = { state: 'disabled', updatedAt: new Date().toISOString() };
let reconnectTimer: NodeJS.Timeout | null = null;

async function setStatus(patch: Omit<WhatsappStatus, 'updatedAt'>) {
  current = { ...patch, updatedAt: new Date().toISOString() };
  const value = current as unknown as Prisma.InputJsonValue;
  await prisma.setting
    .upsert({ where: { key: WHATSAPP_STATUS_KEY }, create: { key: WHATSAPP_STATUS_KEY, value }, update: { value } })
    .catch((err) => console.error('[whatsapp] could not save status', err));
}

/** Status as last saved by the worker (for the API and admin screen). */
export async function readWhatsappStatus(): Promise<WhatsappStatus & { provider: string }> {
  if (env.WHATSAPP_PROVIDER !== 'baileys') return { state: 'disabled', provider: env.WHATSAPP_PROVIDER, updatedAt: new Date().toISOString() };
  const row = await prisma.setting.findUnique({ where: { key: WHATSAPP_STATUS_KEY } });
  const saved = (row?.value as unknown as WhatsappStatus | undefined) ?? { state: 'connecting', updatedAt: new Date().toISOString() };
  return { ...saved, provider: 'baileys' };
}

/** Connect (or reconnect) the linked device. Call once from the worker. */
export async function startWhatsapp(): Promise<void> {
  if (env.WHATSAPP_PROVIDER !== 'baileys') return;
  const baileys: Baileys = await import('@whiskeysockets/baileys');
  const { default: pino } = await import('pino');
  const QRCode = (await import('qrcode')).default;
  const makeWASocket = baileys.makeWASocket ?? (baileys as unknown as { default: Baileys['makeWASocket'] }).default;

  await setStatus({ state: 'connecting' });
  const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir());
  const version = await baileys
    .fetchLatestBaileysVersion()
    .then((v) => v.version)
    .catch(() => undefined);

  const s = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }) as never,
    browser: baileys.Browsers.ubuntu('Fleet alerts'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock = s;
  s.ev.on('creds.update', saveCreds);

  // A pairing code is easier than a QR on a headless server.
  if (env.WHATSAPP_PAIRING_NUMBER && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await s.requestPairingCode(toE164(env.WHATSAPP_PAIRING_NUMBER!).replace('+', ''));
        console.log(`[whatsapp] Pairing code: ${code}  (WhatsApp → Linked devices → Link with phone number)`);
        await setStatus({ state: 'waiting_for_scan', pairingCode: code, qr: current.qr ?? null });
      } catch (err) {
        console.error('[whatsapp] pairing code failed', (err as Error).message);
      }
    }, 3000);
  }

  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('[whatsapp] Scan this QR with the company WhatsApp (Linked devices → Link a device):');
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
      await setStatus({ state: 'waiting_for_scan', qr: await QRCode.toDataURL(qr, { margin: 1, width: 280 }), pairingCode: current.pairingCode ?? null });
    }
    if (connection === 'open') {
      const number = s.user?.id?.split(':')[0]?.split('@')[0] ?? null;
      console.log(`[whatsapp] connected as +${number}`);
      await setStatus({ state: 'connected', number: number ? `+${number}` : null });
    }
    if (connection === 'close') {
      sock = null;
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === baileys.DisconnectReason.loggedOut) {
        // Unlinked from the phone: forget the session and show a fresh QR.
        console.warn('[whatsapp] logged out; clearing the session');
        await setStatus({ state: 'logged_out' });
        await rm(authDir(), { recursive: true, force: true });
      } else {
        await setStatus({ state: 'connecting', error: lastDisconnect?.error?.message ?? null });
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => void startWhatsapp().catch((err) => console.error('[whatsapp]', err)), 5000);
    }
  });
}

export async function stopWhatsapp() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  sock?.end(undefined);
  sock = null;
}

export type SendResult = { status: 'SENT' | 'SKIPPED' | 'FAILED'; error?: string };

/** Send a text from the linked company number. */
export async function sendWhatsappText(phone: string, text: string): Promise<SendResult> {
  if (!sock || current.state !== 'connected') {
    return { status: 'FAILED', error: 'WhatsApp is not linked. Scan the QR code in Admin → Office & settings.' };
  }
  const number = toE164(phone).replace('+', '');
  const [found] = (await sock.onWhatsApp(number)) ?? [];
  if (!found?.exists) return { status: 'SKIPPED', error: `${phone} is not on WhatsApp` };
  await sock.sendMessage(found.jid, { text });
  return { status: 'SENT' };
}
