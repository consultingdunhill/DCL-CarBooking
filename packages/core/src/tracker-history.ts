import { DomainError } from './errors';

/** One position from a tracker's history export. */
export interface TrackerFix {
  recordedAt: Date;
  lat: number;
  lng: number;
  /** As the export reports it. */
  speedKmh: number | null;
  heading: number | null;
  ignition: boolean | null;
  /** The tracker's own odometer. */
  odometerKm: number | null;
}

export interface TrackerHistory {
  /** Oldest first, one per timestamp. */
  fixes: TrackerFix[];
  /** Rows with no position ("Not Locate") or an unreadable time. */
  skipped: number;
  /** Rows repeating a time already read. */
  duplicates: number;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    rows.push([...tr[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((td) => cellText(td[1]!)));
  }
  return rows;
}

const num = (v: string | undefined): number | null => {
  const n = v ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Read Oversee's "Location History Records Report" export. Despite the .xls
 * name it is an HTML table (the site saves it with table2excel), one row per
 * position:
 *
 *   Date and Time | Coordinates/Address | Speed (Km/h) | Direction(°) | Ignition | Mileage (Km) | …
 *
 * Times are wall-clock in the Oversee account's timezone with no zone marked;
 * `utcOffsetMin` is that zone's offset from UTC (Kenya: 180).
 */
export function parseOverseeHistory(html: string, utcOffsetMin: number): TrackerHistory {
  const rows = tableRows(html);
  const headerAt = rows.findIndex((r) => r.some((c) => /^date and time$/i.test(c)) && r.some((c) => /^coordinates/i.test(c)));
  if (headerAt < 0) {
    throw new DomainError(
      'BAD_TRACKER_FILE',
      "This isn't an Oversee Location History Records Report. On Oversee, open Reports and Charts → Location History Records Report, export it, and upload the file as it downloads.",
    );
  }
  const header = rows[headerAt]!.map((c) => c.toLowerCase());
  const col = (re: RegExp) => header.findIndex((c) => re.test(c));
  const at = { time: col(/^date and time$/), coords: col(/^coordinates/), speed: col(/^speed/), heading: col(/^direction/), ignition: col(/^ignition/), odometer: col(/^mileage/) };

  const byTime = new Map<number, TrackerFix>();
  let skipped = 0;
  let duplicates = 0;
  for (const r of rows.slice(headerAt + 1)) {
    const t = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})$/.exec(r[at.time] ?? '');
    const p = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(r[at.coords] ?? '');
    const lat = p ? Number(p[1]) : NaN;
    const lng = p ? Number(p[2]) : NaN;
    if (!t || !p || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      skipped++;
      continue;
    }
    const ms = Date.UTC(+t[1]!, +t[2]! - 1, +t[3]!, +t[4]!, +t[5]!, +t[6]!) - utcOffsetMin * 60_000;
    if (byTime.has(ms)) {
      duplicates++;
      continue;
    }
    const ignition = (r[at.ignition] ?? '').toUpperCase();
    byTime.set(ms, {
      recordedAt: new Date(ms),
      lat,
      lng,
      speedKmh: num(r[at.speed]),
      heading: num(r[at.heading]),
      ignition: ignition === 'ON' ? true : ignition === 'OFF' ? false : null,
      odometerKm: num(r[at.odometer]),
    });
  }
  const fixes = [...byTime.values()].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  return { fixes, skipped, duplicates };
}
