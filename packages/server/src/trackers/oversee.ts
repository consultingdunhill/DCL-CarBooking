import { env } from '../env';
import { TrackerError, type TrackerPosition, type TrackerProvider } from './types';

/**
 * Oversee Tracking (api.overseetracking.com). The whole product runs on one
 * command endpoint — WebProcessorApi.ashx — that dispatches on a multipart body:
 *
 *   Token, OperationType, InformationType, LanguageType, Arguments
 *
 * Transport, auth and the position query were recovered from the vendor's public
 * web client (js/Public.js builds the envelope; login.aspx + js/home/index.js
 * hold the commands):
 *
 *   SignIn:  OperationType=SignIn, InformationType=User,
 *            Arguments={UserName,Password} → { State:"0", Token, Data }
 *   Poll:    OperationType=GetMyTracker, InformationType=Product,
 *            Arguments={TrackerType:"0"} → Data.Tracker[] + Data.Position[]
 *
 * GetMyTracker returns the account's trackers with their *latest* fix. We poll it
 * on the worker's cadence and store each fix, so the breadcrumb accumulates over
 * the trip. Car.trackerDeviceId is the tracker's SystemNo.
 *
 * NOTE (verify on first live connect): Position.DateTime has no timezone in the
 * payload; we read it as UTC. If fixes land in the wrong window, set the offset
 * via OVERSEE_TZ_OFFSET_MIN. Velocity is assumed km/h (converted to m/s).
 */

interface OverseePosition {
  SystemNo: string | number;
  DateTime?: string;
  Latitude?: number | string;
  Longitude?: number | string;
  Velocity?: number | string;
  Angle?: number | string;
  Altitude?: number | string;
  Acc?: number | string;
}
interface OverseeResponse {
  State?: string;
  Token?: string;
  Data?: { Position?: OverseePosition[] };
}

/** "yyyy-MM-dd HH:mm:ss" (no zone) → Date, read as UTC plus the configured offset. */
function parseDateTime(dt: string | undefined): Date | null {
  if (!dt) return null;
  const iso = dt.trim().replace(' ', 'T');
  const base = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(base)) return null;
  return new Date(base - env.OVERSEE_TZ_OFFSET_MIN * 60_000);
}

function num(v: number | string | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export class OverseeTrackerProvider implements TrackerProvider {
  readonly name = 'oversee';
  private token: string | null = null;

  /** POST the recovered envelope and return the parsed JSON body. */
  private async call(operationType: string, informationType: string, args: Record<string, unknown>, token = ''): Promise<OverseeResponse> {
    const fd = new FormData();
    fd.append('Token', token);
    fd.append('OperationType', operationType);
    fd.append('InformationType', informationType);
    fd.append('LanguageType', env.OVERSEE_LANGUAGE_TYPE);
    fd.append('Arguments', JSON.stringify(args));
    let res: Response;
    try {
      res = await fetch(env.OVERSEE_API_URL, { method: 'POST', body: fd, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new TrackerError(`Oversee ${operationType} did not answer: ${(err as Error).message}`);
    }
    if (!res.ok) throw new TrackerError(`Oversee ${operationType} → HTTP ${res.status}`);
    return (await res.json()) as OverseeResponse;
  }

  private async signIn(): Promise<string> {
    if (!env.OVERSEE_USERNAME || !env.OVERSEE_PASSWORD) throw new TrackerError('OVERSEE_USERNAME/OVERSEE_PASSWORD not set');
    const res = await this.call('SignIn', 'User', { UserName: env.OVERSEE_USERNAME, Password: env.OVERSEE_PASSWORD }, '');
    if (res.State !== '0' || !res.Token) throw new TrackerError(`Oversee SignIn failed (State=${res.State ?? '?'})`);
    this.token = res.Token;
    return res.Token;
  }

  async fetchPositions(deviceIds: string[], since: Date): Promise<TrackerPosition[]> {
    const token = this.token ?? (await this.signIn());
    let res = await this.call('GetMyTracker', 'Product', { TrackerType: '0' }, token);
    // Token expired / invalid → sign in once and retry.
    if (res.State !== '0') {
      this.token = null;
      res = await this.call('GetMyTracker', 'Product', { TrackerType: '0' }, await this.signIn());
    }
    if (res.State !== '0' || !res.Data?.Position) return [];

    const wanted = new Set(deviceIds.map(String));
    const out: TrackerPosition[] = [];
    for (const p of res.Data.Position) {
      const deviceId = String(p.SystemNo);
      if (!wanted.has(deviceId)) continue;
      const recordedAt = parseDateTime(p.DateTime);
      const lat = num(p.Latitude);
      const lng = num(p.Longitude);
      if (!recordedAt || lat == null || lng == null) continue;
      if (recordedAt.getTime() <= since.getTime()) continue;
      const velocity = num(p.Velocity);
      const acc = num(p.Acc);
      out.push({
        deviceId,
        recordedAt,
        lat,
        lng,
        speed: velocity != null ? velocity / 3.6 : null, // km/h → m/s
        heading: num(p.Angle),
        altitude: num(p.Altitude),
        ignition: acc == null ? null : acc === 1,
        battery: null, // Oversee reports Voltage, not a battery %
      });
    }
    return out;
  }
}
