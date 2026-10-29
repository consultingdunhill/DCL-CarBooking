import { toE164 } from '@carbooking/core';
import { prisma, type Notification, type PushSubscription, type User } from '@carbooking/db';
import webpush from 'web-push';
import { env } from './env';
import { sendWhatsappText } from './whatsapp';

type Outcome = { status: 'SENT' | 'SKIPPED' | 'FAILED'; error?: string };

const absoluteLink = (link: string | null) => (link ? new URL(link, env.APP_URL).toString() : env.APP_URL);

// ── Push: Web Push (PWA/desktop) and FCM (iOS/Android app) ────────────────────

let vapidReady = false;
function ensureVapid() {
  if (vapidReady || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return vapidReady;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  vapidReady = true;
  return true;
}

let fcm: { send: (msg: object) => Promise<string> } | null | undefined;
async function getFcm() {
  if (fcm !== undefined) return fcm;
  if (!env.FCM_SERVICE_ACCOUNT_BASE64) return (fcm = null);
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getMessaging } = await import('firebase-admin/messaging');
  const account = JSON.parse(Buffer.from(env.FCM_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
  const app = getApps()[0] ?? initializeApp({ credential: cert(account) });
  const messaging = getMessaging(app);
  fcm = { send: (msg) => messaging.send(msg as Parameters<typeof messaging.send>[0]) };
  return fcm;
}

async function sendPush(n: Notification, subs: PushSubscription[]): Promise<Outcome> {
  if (subs.length === 0) return { status: 'SKIPPED', error: 'No device registered for push' };
  const errors: string[] = [];
  let sent = 0;
  for (const sub of subs) {
    try {
      if (sub.kind === 'WEB') {
        if (!ensureVapid()) {
          errors.push('Web Push not configured');
          continue;
        }
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
          JSON.stringify({ title: n.title, body: n.body, link: n.link, id: n.id, type: n.type }),
          { TTL: 3600, urgency: n.type.includes('URGENT') ? 'high' : 'normal' },
        );
      } else {
        const client = await getFcm();
        if (!client) {
          errors.push('FCM not configured');
          continue;
        }
        await client.send({
          token: sub.endpoint,
          notification: { title: n.title, body: n.body },
          data: { link: n.link ?? '', id: n.id, type: n.type },
          android: { priority: 'high' },
          apns: { payload: { aps: { sound: 'default' } } },
        });
      }
      sent++;
      await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastUsedAt: new Date() } });
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      // Expired subscriptions/tokens: forget them.
      if (e.statusCode === 404 || e.statusCode === 410 || e.code === 'messaging/registration-token-not-registered') {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      }
      errors.push(e.message ?? String(err));
    }
  }
  if (sent > 0) return { status: 'SENT' };
  return errors.every((e) => e.includes('not configured')) ? { status: 'SKIPPED', error: errors.join('; ') } : { status: 'FAILED', error: errors.join('; ') };
}

// ── Email: Microsoft Graph sendMail from a shared mailbox ─────────────────────

let graphToken: { value: string; expires: number } | null = null;
async function getGraphToken(): Promise<string> {
  if (graphToken && graphToken.expires > Date.now() + 60_000) return graphToken.value;
  const res = await fetch(`https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GRAPH_CLIENT_ID!,
      client_secret: env.GRAPH_CLIENT_SECRET!,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Graph token ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  graphToken = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function sendEmail(n: Notification, user: User): Promise<Outcome> {
  if (!env.GRAPH_TENANT_ID || !env.GRAPH_CLIENT_ID || !env.GRAPH_CLIENT_SECRET || !env.GRAPH_SENDER) {
    return { status: 'SKIPPED', error: 'Email (Microsoft Graph) not configured' };
  }
  const link = absoluteLink(n.link);
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#1f2937">
<p style="font-size:17px;font-weight:600;margin:0 0 8px">${escapeHtml(n.title)}</p>
<p style="margin:0 0 16px">${escapeHtml(n.body)}</p>
<p><a href="${link}" style="background:#0f766e;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open in Fleet</a></p>
<p style="color:#6b7280;font-size:12px">You get this because you use the company car booking app.</p></div>`;
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.GRAPH_SENDER)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getGraphToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: n.title,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: user.email, name: user.name } }],
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) return { status: 'FAILED', error: `Graph ${res.status}: ${(await res.text()).slice(0, 300)}` };
  return { status: 'SENT' };
}

// ── SMS / WhatsApp: Africa's Talking or Twilio ────────────────────────────────

async function sendSms(n: Notification, user: User): Promise<Outcome> {
  if (!user.phone) return { status: 'SKIPPED', error: 'No phone number on file' };
  const to = toE164(user.phone);
  const text = `${n.title}: ${n.body}`.slice(0, 300);
  if (env.SMS_PROVIDER === 'africastalking' && env.AFRICASTALKING_USERNAME && env.AFRICASTALKING_API_KEY) {
    const body = new URLSearchParams({ username: env.AFRICASTALKING_USERNAME, to, message: text });
    if (env.AFRICASTALKING_SENDER_ID) body.set('from', env.AFRICASTALKING_SENDER_ID);
    const host = env.AFRICASTALKING_USERNAME === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const res = await fetch(`https://${host}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey: env.AFRICASTALKING_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) return { status: 'FAILED', error: `Africa's Talking ${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { status: 'SENT' };
  }
  if (env.SMS_PROVIDER === 'twilio' && env.TWILIO_SMS_FROM) return twilio(to, env.TWILIO_SMS_FROM, text);
  return { status: 'SKIPPED', error: 'SMS not configured' };
}

async function sendWhatsapp(n: Notification, user: User): Promise<Outcome> {
  if (!user.phone) return { status: 'SKIPPED', error: 'No phone number on file' };
  const text = `*${n.title}*\n${n.body}${n.link ? `\n${absoluteLink(n.link)}` : ''}`;
  if (env.WHATSAPP_PROVIDER === 'baileys') return sendWhatsappText(user.phone, text);
  if (env.WHATSAPP_PROVIDER === 'twilio' && env.TWILIO_WHATSAPP_FROM) return twilio(`whatsapp:${toE164(user.phone)}`, `whatsapp:${env.TWILIO_WHATSAPP_FROM}`, text);
  return { status: 'SKIPPED', error: 'WhatsApp not configured' };
}

async function twilio(to: string, from: string, text: string): Promise<Outcome> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return { status: 'SKIPPED', error: 'Twilio not configured' };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: text }),
  });
  if (!res.ok) return { status: 'FAILED', error: `Twilio ${res.status}: ${(await res.text()).slice(0, 300)}` };
  return { status: 'SENT' };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/** Deliver pending notifications. Safe to call repeatedly: only PENDING rows are sent. */
export async function dispatchNotifications(ids: string[]): Promise<void> {
  const rows = await prisma.notification.findMany({
    where: { id: { in: ids }, status: 'PENDING' },
    include: { user: { include: { pushSubscriptions: true } } },
  });
  for (const n of rows) {
    let outcome: Outcome;
    try {
      if (!n.user.active) outcome = { status: 'SKIPPED', error: 'User inactive' };
      else if (n.channel === 'PUSH') outcome = await sendPush(n, n.user.pushSubscriptions);
      else if (n.channel === 'EMAIL') outcome = await sendEmail(n, n.user);
      else if (n.channel === 'SMS') outcome = await sendSms(n, n.user);
      else if (n.channel === 'WHATSAPP') outcome = await sendWhatsapp(n, n.user);
      else outcome = { status: 'SENT' };
    } catch (err) {
      outcome = { status: 'FAILED', error: (err as Error).message };
    }
    await prisma.notification.update({
      where: { id: n.id },
      data: { status: outcome.status, error: outcome.error?.slice(0, 1000) ?? null, sentAt: outcome.status === 'SENT' ? new Date() : null },
    });
    if (outcome.status === 'SKIPPED' && env.NODE_ENV !== 'production') {
      console.log(`[notify:${n.channel}] (not sent: ${outcome.error}) → ${n.user.email}: ${n.title} — ${n.body}`);
    }
  }
}

export const pushConfigured = () => ({
  web: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
  fcm: Boolean(env.FCM_SERVICE_ACCOUNT_BASE64),
});
