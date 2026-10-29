import { ENV } from './env';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type TokenGetter = () => Promise<string | null>;
let getToken: TokenGetter = async () => null;
let onUnauthorized: () => void = () => {};

export function configureApi(opts: { getToken: TokenGetter; onUnauthorized: () => void }) {
  getToken = opts.getToken;
  onUnauthorized = opts.onUnauthorized;
}

export async function authHeader(): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** JSON request to the API. Throws ApiError with the server's message. */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(await authHeader())) headers.set(k, v);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`${ENV.apiUrl}${path}`, { ...init, headers, body });
  } catch {
    throw new ApiError(0, 'NETWORK', "Can't reach the server. Check your connection.");
  }
  if (res.status === 401) onUnauthorized();
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_' + res.status, err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, json?: unknown) => api<T>(path, { method: 'POST', json: json ?? {} });
export const put = <T>(path: string, json?: unknown) => api<T>(path, { method: 'PUT', json: json ?? {} });
export const patch = <T>(path: string, json?: unknown) => api<T>(path, { method: 'PATCH', json: json ?? {} });
export const del = <T>(path: string, json?: unknown) => api<T>(path, { method: 'DELETE', json });

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

/** Upload a file through a signed URL; returns the storage key. */
export async function uploadFile(kind: 'ODOMETER_START' | 'ODOMETER_END' | 'RECEIPT', file: Blob): Promise<string> {
  const contentType = file.type && file.type !== '' ? file.type : 'image/jpeg';
  const target = await post<{ key: string; url: string; method: 'PUT'; headers: Record<string, string> }>('/uploads', { kind, contentType });
  const res = await fetch(target.url, { method: 'PUT', body: file, headers: { 'Content-Type': contentType, ...target.headers } });
  if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', 'The photo upload failed. Try again.');
  return target.key;
}

/** Download a file from an authenticated endpoint (CSV/XLSX exports). */
export async function download(path: string, fileName: string) {
  const res = await fetch(`${ENV.apiUrl}${path}`, { headers: await authHeader() });
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** POST a multipart file upload (CSV imports). */
export async function postFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return api<T>(path, { method: 'POST', body: form });
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
