import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from '@azure/msal-browser';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { configureApi, get, post } from './api';
import { ENV, isNative } from './env';
import { nativeGetToken, nativeSignIn, nativeSignOut } from './native-auth';
import type { Me } from './types';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: Status;
  me: Me | null;
  isAdmin: boolean;
  signIn: () => Promise<void>;
  signInDev: (userId: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const DEV_TOKEN_KEY = 'fleet.devToken';

// ── Token sources ─────────────────────────────────────────────────────────────

let msal: PublicClientApplication | null = null;
async function getMsal() {
  if (msal) return msal;
  msal = new PublicClientApplication({
    auth: {
      clientId: ENV.entraClientId!,
      authority: `https://login.microsoftonline.com/${ENV.entraTenantId}`,
      redirectUri: `${window.location.origin}/`,
      postLogoutRedirectUri: `${window.location.origin}/`,
    },
    cache: { cacheLocation: 'localStorage' },
  });
  await msal.initialize();
  const result = await msal.handleRedirectPromise();
  if (result?.account) msal.setActiveAccount(result.account);
  return msal;
}

function account(m: PublicClientApplication): AccountInfo | null {
  return m.getActiveAccount() ?? m.getAllAccounts()[0] ?? null;
}

const scopes = () => [ENV.entraApiScope!];

async function entraToken(): Promise<string | null> {
  if (isNative) return nativeGetToken();
  const m = await getMsal();
  const acc = account(m);
  if (!acc) return null;
  try {
    return (await m.acquireTokenSilent({ scopes: scopes(), account: acc })).accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      await m.acquireTokenRedirect({ scopes: scopes(), account: acc });
    }
    return null;
  }
}

const devToken = async () => localStorage.getItem(DEV_TOKEN_KEY);

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const qc = useQueryClient();
  const signingOut = useRef(false);

  const loadMe = useCallback(async () => {
    try {
      const profile = await get<Me>('/me');
      setMe(profile);
      setStatus('signedIn');
    } catch {
      setMe(null);
      setStatus('signedOut');
    }
  }, []);

  useEffect(() => {
    configureApi({
      getToken: ENV.authMode === 'dev' ? devToken : entraToken,
      onUnauthorized: () => {
        if (signingOut.current) return;
        if (ENV.authMode === 'dev') localStorage.removeItem(DEV_TOKEN_KEY);
        setMe(null);
        setStatus('signedOut');
      },
    });
    (async () => {
      const token = ENV.authMode === 'dev' ? await devToken() : await entraToken().catch(() => null);
      if (token) await loadMe();
      else setStatus('signedOut');
    })();
  }, [loadMe]);

  const signIn = useCallback(async () => {
    if (ENV.authMode === 'dev') return;
    if (isNative) {
      await nativeSignIn();
      await loadMe();
    } else {
      const m = await getMsal();
      await m.loginRedirect({ scopes: scopes(), prompt: 'select_account' });
    }
  }, [loadMe]);

  const signInDev = useCallback(
    async (userId: string) => {
      const { token } = await post<{ token: string }>('/auth/dev-login', { userId });
      localStorage.setItem(DEV_TOKEN_KEY, token);
      qc.clear();
      await loadMe();
    },
    [loadMe, qc],
  );

  const signOut = useCallback(async () => {
    signingOut.current = true;
    qc.clear();
    setMe(null);
    setStatus('signedOut');
    if (ENV.authMode === 'dev') localStorage.removeItem(DEV_TOKEN_KEY);
    else if (isNative) await nativeSignOut();
    else {
      const m = await getMsal();
      await m.logoutRedirect({ account: account(m) });
    }
    signingOut.current = false;
  }, [qc]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, me, isAdmin: me?.role === 'ADMIN', signIn, signInDev, signOut, refreshMe: loadMe }),
    [status, me, signIn, signInDev, signOut, loadMe],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** The signed-in user (only call inside signed-in routes). */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('Not signed in');
  return me;
}
