/**
 * Microsoft 365 sign-in on the native app: authorization code + PKCE through
 * the system browser (not an embedded web view), redirecting back to the app
 * via its custom URL scheme. Tokens are exchanged with native HTTP because
 * Entra's token endpoint doesn't allow CORS for mobile redirect URIs.
 */
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { ENV } from './env';

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

const KEY = 'fleet.auth.tokens';
const authority = () => `https://login.microsoftonline.com/${ENV.entraTenantId}/oauth2/v2.0`;
const scope = () => `openid profile offline_access ${ENV.entraApiScope ?? ''}`.trim();

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function save(t: Tokens | null) {
  if (t) await Preferences.set({ key: KEY, value: JSON.stringify(t) });
  else await Preferences.remove({ key: KEY });
}

async function load(): Promise<Tokens | null> {
  const { value } = await Preferences.get({ key: KEY });
  return value ? (JSON.parse(value) as Tokens) : null;
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const res = await CapacitorHttp.post({
    url: `${authority()}/token`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: new URLSearchParams({ client_id: ENV.entraClientId!, scope: scope(), ...params }).toString(),
  });
  const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  if (res.status !== 200 || !body.access_token) throw new Error(body.error_description ?? 'Sign-in failed');
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
}

export async function nativeSignIn(): Promise<void> {
  const { verifier, challenge } = await pkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const url =
    `${authority()}/authorize?` +
    new URLSearchParams({
      client_id: ENV.entraClientId!,
      response_type: 'code',
      redirect_uri: ENV.entraNativeRedirect,
      scope: scope(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      prompt: 'select_account',
    });

  await new Promise<void>((resolve, reject) => {
    let handle: { remove: () => Promise<void> } | null = null;
    void App.addListener('appUrlOpen', async ({ url: back }) => {
      if (!back.startsWith(ENV.entraNativeRedirect)) return;
      await handle?.remove();
      await Browser.close().catch(() => {});
      const params = new URL(back.replace(/^[^:]+:\/\//, 'https://x/')).searchParams;
      if (params.get('state') !== state) return reject(new Error('Sign-in was interrupted. Try again.'));
      const code = params.get('code');
      if (!code) return reject(new Error(params.get('error_description') ?? 'Sign-in cancelled'));
      try {
        await save(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: ENV.entraNativeRedirect, code_verifier: verifier }));
        resolve();
      } catch (err) {
        reject(err);
      }
    }).then((h) => (handle = h));
    void Browser.open({ url, presentationStyle: 'popover' });
  });
}

export async function nativeGetToken(): Promise<string | null> {
  const t = await load();
  if (!t) return null;
  if (t.expiresAt > Date.now()) return t.accessToken;
  if (!t.refreshToken) return null;
  try {
    const next = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
    await save({ ...next, refreshToken: next.refreshToken ?? t.refreshToken });
    return next.accessToken;
  } catch {
    await save(null);
    return null;
  }
}

export async function nativeSignOut() {
  await save(null);
}
