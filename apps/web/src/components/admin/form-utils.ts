import type { z } from 'zod';

/** First problem per field, keyed by dotted path ('name', 'newClient.email'). */
export type FieldErrors = Record<string, string>;

interface Issue {
  code: string;
  path: PropertyKey[];
  message: string;
  origin?: string;
  minimum?: unknown;
  maximum?: unknown;
  inclusive?: boolean;
  expected?: string;
}

/** Turn zod's wording into short, plain messages. */
function friendly(i: Issue): string {
  const msg = i.message;
  if (i.code === 'invalid_type') {
    if (/received (undefined|null)/.test(msg)) return 'Required';
    if (/received NaN/.test(msg) || i.expected === 'number') return 'Enter a number';
    return msg;
  }
  // Keep messages the schema wrote itself.
  if (!msg.startsWith('Too small') && !msg.startsWith('Too big') && !msg.startsWith('Invalid')) return msg;
  if (i.code === 'too_small') {
    if (i.origin === 'string') return Number(i.minimum) <= 1 ? 'Required' : `At least ${String(i.minimum)} characters`;
    if (i.origin === 'number') return i.inclusive === false ? `Must be more than ${String(i.minimum)}` : `Must be at least ${String(i.minimum)}`;
  }
  if (i.code === 'too_big') {
    if (i.origin === 'string') return `Up to ${String(i.maximum)} characters`;
    if (i.origin === 'number') return i.inclusive === false ? `Must be less than ${String(i.maximum)}` : `Must be at most ${String(i.maximum)}`;
  }
  if (i.code === 'invalid_value') return 'Choose an option';
  if (i.code === 'invalid_format') {
    if (/email/i.test(msg)) return 'Enter a valid email address';
    return 'Check the format';
  }
  if (i.code === 'invalid_union') return 'Check this value';
  return msg;
}

export function issuesToErrors(issues: readonly Issue[]): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const key = i.path.map(String).join('.') || '_form';
    if (!(key in out)) out[key] = friendly(i);
  }
  return out;
}

/** safeParse with the core schema; returns the parsed value or per-field errors. */
export function check<S extends z.ZodType>(schema: S, data: unknown): { ok: true; data: z.output<S> } | { ok: false; errors: FieldErrors } {
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, errors: issuesToErrors(r.error.issues as unknown as Issue[]) };
}

/** '' → undefined, otherwise a number (NaN shows "Enter a number"). */
export function numOrUndef(s: string): number | undefined {
  const t = s.trim();
  return t === '' ? undefined : Number(t.replace(/,/g, ''));
}

/** '' → null, otherwise a number. For optional numeric fields. */
export function numOrNull(s: string): number | null {
  const t = s.trim();
  return t === '' ? null : Number(t.replace(/,/g, ''));
}

/** '' → null for optional text fields. */
export function textOrNull(s: string): string | null {
  const t = s.trim();
  return t === '' ? null : t;
}

export const str = (v: number | string | null | undefined) => (v == null ? '' : String(v));
