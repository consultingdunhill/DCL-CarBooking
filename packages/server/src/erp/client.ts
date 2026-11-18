/** Thin client for ERPNext's REST API, used by the sync to keep the ERP's copy of Fleet current. */
import { env } from '../env';

export class ErpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly excType = '',
  ) {
    super(message);
    this.name = 'ErpError';
  }
}

export interface ErpClientOptions {
  url: string;
  apiKey?: string;
  apiSecret?: string;
  user?: string;
  password?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** ERPNext's own message, which is buried in a JSON-encoded list of JSON strings. */
async function errorText(res: Response): Promise<{ text: string; excType: string }> {
  const raw = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return { text: raw.slice(0, 300), excType: '' };
  }
  const excType = String(data.exc_type ?? '');
  if (typeof data._server_messages === 'string') {
    try {
      const first = JSON.parse(JSON.parse(data._server_messages)[0]);
      return { text: String(first.message ?? first).replace(/<[^>]+>/g, '').slice(0, 300), excType };
    } catch {
      /* fall through */
    }
  }
  for (const key of ['exception', 'message']) {
    if (data[key]) return { text: String(data[key]).slice(0, 300), excType };
  }
  return { text: (excType || raw).slice(0, 300), excType };
}

export class ErpClient {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string> = { Accept: 'application/json' };
  /** With a password: the session cookie, kept for the client's life and renewed when dropped. */
  private readonly login?: { user: string; password: string };
  private cookie = '';
  /** A sign-in under way, shared by requests sent at the same moment so they sign in once. */
  private signingIn?: Promise<void>;

  constructor(opts: ErpClientOptions) {
    if (!/^https?:\/\//.test(opts.url)) throw new ErpError("ERP_URL must be the site's address, e.g. https://erp.example.com");
    this.base = opts.url.replace(/\/+$/, '');
    this.fetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (opts.apiKey && opts.apiSecret) this.headers.Authorization = `token ${opts.apiKey}:${opts.apiSecret}`;
    else if (opts.user && opts.password) this.login = { user: opts.user, password: opts.password };
    else throw new ErpError('Set ERP_API_KEY and ERP_API_SECRET, or ERP_USER and ERP_PASSWORD');
  }

  static fromEnv(): ErpClient {
    if (!env.ERP_URL) throw new ErpError('ERP_URL is not set');
    return new ErpClient({
      url: env.ERP_URL,
      apiKey: env.ERP_API_KEY,
      apiSecret: env.ERP_API_SECRET,
      user: env.ERP_USER,
      password: env.ERP_PASSWORD,
    });
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { ...this.headers };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ErpError(`ERP unreachable: ${(err as Error).message}`);
    }
  }

  private signIn(): Promise<void> {
    this.signingIn ??= this.doSignIn().finally(() => {
      this.signingIn = undefined;
    });
    return this.signingIn;
  }

  private async doSignIn(): Promise<void> {
    const { user, password } = this.login!;
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/api/method/login`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ usr: user, pwd: password }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ErpError(`ERP unreachable: ${(err as Error).message}`);
    }
    if (res.status !== 200) throw new ErpError(`ERP sign-in failed: HTTP ${res.status}`, res.status);
    this.cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .join('; ');
  }

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    if (this.login && !this.cookie) await this.signIn();
    let res = await this.send(method, path, body);
    if (this.login && (res.status === 401 || res.status === 403)) {
      await this.signIn(); // ERPNext dropped the session: renew once
      res = await this.send(method, path, body);
    }
    if (res.status >= 400) {
      const { text, excType } = await errorText(res);
      throw new ErpError(`HTTP ${res.status}: ${text}`, res.status, excType);
    }
    const raw = await res.text();
    return raw ? JSON.parse(raw) : {};
  }

  private static path(doctype: string, name?: string): string {
    const p = `/api/resource/${encodeURIComponent(doctype)}`;
    return name ? `${p}/${encodeURIComponent(name)}` : p;
  }

  async names(doctype: string): Promise<Set<string>> {
    const q = new URLSearchParams({ fields: '["name"]', limit_page_length: '0' });
    const data = await this.request('GET', `${ErpClient.path(doctype)}?${q}`);
    return new Set(((data.data as { name: string }[]) ?? []).map((r) => r.name));
  }

  /**
   * Create or update one document. `exists` is the caller's belief; ERPNext has the last
   * word: an update of a missing document becomes a create, and a create of one that is
   * there becomes an update.
   */
  async upsert(doctype: string, name: string, doc: Record<string, unknown>, exists: boolean): Promise<'created' | 'updated'> {
    if (exists) {
      try {
        await this.request('PUT', ErpClient.path(doctype, name), doc);
        return 'updated';
      } catch (err) {
        if (!(err instanceof ErpError) || err.status !== 404) throw err;
      }
    }
    try {
      await this.request('POST', ErpClient.path(doctype), doc);
      return 'created';
    } catch (err) {
      if (!(err instanceof ErpError) || (err.status !== 409 && !err.excType.includes('Duplicate'))) throw err;
    }
    await this.request('PUT', ErpClient.path(doctype, name), doc);
    return 'updated';
  }

  /** True if it was there and is now gone; false if it was already gone. */
  async delete(doctype: string, name: string): Promise<boolean> {
    try {
      await this.request('DELETE', ErpClient.path(doctype, name));
      return true;
    } catch (err) {
      if (err instanceof ErpError && err.status === 404) return false;
      throw err;
    }
  }
}
