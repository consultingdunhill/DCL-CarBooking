import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useElementWidth, useMediaQuery } from './hooks';

// Categorical palette validated for colour-vision deficiency on adjacent pairs
// (blue, orange, aqua, yellow, magenta, green, violet, red), stepped per theme.
const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

type Cell = string | number | null;

function niceStep(raw: number) {
  if (raw <= 0 || !Number.isFinite(raw)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const f = raw / 10 ** exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

const shortLabel = (s: string) => s.split(' (')[0]!;

/**
 * Small hand-written line chart: one series per `seriesBy` value, x is an
 * ordered category (months), y a number. Colours follow the entity via
 * `seriesOrder`, so filtering never repaints a series.
 */
export function LineChart({
  rows,
  x,
  y,
  seriesBy,
  label,
  seriesOrder = [],
  formatX = (v) => v,
  formatXTick,
  formatY,
  height = 260,
  className,
}: {
  rows: Record<string, Cell>[];
  x: string;
  y: string;
  seriesBy: string;
  label: string;
  seriesOrder?: string[];
  formatX?: (v: string) => string;
  formatXTick?: (v: string, i: number) => string;
  formatY: (v: number) => string;
  height?: number;
  className?: string;
}) {
  const [wrap, width] = useElementWidth();
  const dark = useMediaQuery('(prefers-color-scheme: dark)');
  const palette = dark ? DARK : LIGHT;
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    const xs = [...new Set(rows.map((r) => String(r[x] ?? '')).filter(Boolean))].sort();
    const names = [...new Set(rows.map((r) => String(r[seriesBy] ?? '—')))];
    const unknown = names.filter((n) => !seriesOrder.includes(n)).sort();
    const order = [...seriesOrder, ...unknown];
    const all = names
      .map((name) => ({ name, colorIdx: order.indexOf(name) }))
      .sort((a, b) => a.colorIdx - b.colorIdx);
    const values = new Map<string, (number | null)[]>();
    for (const s of all) values.set(s.name, xs.map(() => null));
    for (const r of rows) {
      const list = values.get(String(r[seriesBy] ?? '—'));
      const i = xs.indexOf(String(r[x] ?? ''));
      const v = r[y];
      if (list && i >= 0 && typeof v === 'number' && Number.isFinite(v)) list[i] = v;
    }
    // Series with nothing to plot stay in the table only. Never cycle colours:
    // past the palette, series are left to the table too.
    const plotted = all.filter((s) => values.get(s.name)!.some((v) => v != null));
    const series = plotted.filter((s) => s.colorIdx < palette.length);
    const hidden = plotted.length - series.length;
    for (const name of [...values.keys()]) if (!series.some((s) => s.name === name)) values.delete(name);
    let max = 0;
    for (const list of values.values()) for (const v of list) if (v != null && v > max) max = v;
    const step = niceStep(max / 4);
    const top = max > 0 ? Math.ceil(max / step) * step : step;
    const ticks: number[] = [];
    for (let t = 0; t <= top + step / 1000; t += step) ticks.push(Number(t.toFixed(10)));
    const hasData = [...values.values()].some((l) => l.some((v) => v != null));
    return { xs, series, hidden, values, top, ticks, hasData };
  }, [rows, x, y, seriesBy, seriesOrder, palette.length]);

  const { xs, series, values, top, ticks } = model;
  const direct = series.length >= 2 && series.length <= 4 && width >= 520;
  const yLabelW = Math.max(...ticks.map((t) => formatY(t).length)) * 6.6 + 12;
  const m = { top: 14, right: direct ? 92 : 18, bottom: 30, left: Math.max(36, yLabelW) };
  const W = Math.max(width, 280);
  const H = height;
  const pw = Math.max(10, W - m.left - m.right);
  const ph = H - m.top - m.bottom;
  const step = xs.length ? pw / xs.length : pw;
  const px = (i: number) => m.left + step * (i + 0.5);
  const py = (v: number) => m.top + ph - (v / top) * ph;
  const labelEvery = Math.max(1, Math.ceil((xs.length * 58) / pw));
  const color = (idx: number) => palette[idx]!;

  const paths = series.map((s) => {
    const list = values.get(s.name)!;
    let d = '';
    let pen = false;
    list.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`;
      pen = true;
    });
    return { ...s, d, list };
  });

  // Labels at the right edge for 2–4 series, nudged apart so they never overlap.
  const labels = direct
    ? paths
        .map((p) => {
          let li = -1;
          p.list.forEach((v, i) => {
            if (v != null) li = i;
          });
          return li < 0 ? null : { name: p.name, colorIdx: p.colorIdx, y: py(p.list[li]!) };
        })
        .filter((l): l is { name: string; colorIdx: number; y: number } => l != null)
        .sort((a, b) => a.y - b.y)
    : [];
  for (let i = 1; i < labels.length; i++) if (labels[i]!.y - labels[i - 1]!.y < 14) labels[i]!.y = labels[i - 1]!.y + 14;
  const overflow = labels.length ? labels[labels.length - 1]!.y - (m.top + ph) : 0;
  if (overflow > 0) labels.forEach((l) => (l.y -= overflow));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xPos = ((e.clientX - rect.left) / rect.width) * W;
    if (!xs.length || xPos < m.left - step / 2 || xPos > m.left + pw + step / 2) return setHover(null);
    setHover(Math.min(xs.length - 1, Math.max(0, Math.floor((xPos - m.left) / step))));
  };

  const tooltipLeft = hover != null ? (px(hover) + 196 > W ? px(hover) - 188 : px(hover) + 12) : 0;

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {series.length >= 2 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Legend">
          {series.map((s) => (
            <li key={s.name} className="flex items-center gap-1.5">
              <svg width="18" height="10" aria-hidden>
                <line x1="1" x2="17" y1="5" y2="5" stroke={color(s.colorIdx)} strokeWidth="2" strokeLinecap="round" />
                <circle cx="9" cy="5" r="3.5" fill={color(s.colorIdx)} stroke="var(--surface)" strokeWidth="1.5" />
              </svg>
              <span className="text-fg">{s.name}</span>
            </li>
          ))}
          {model.hidden > 0 && <li className="text-muted-fg">+{model.hidden} more in the table</li>}
        </ul>
      )}
      <div ref={wrap} className="relative w-full">
        {width > 0 && (
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${label}, by ${seriesBy}. The table below has the figures.`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            className="block touch-pan-y select-none"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.left} x2={m.left + pw} y1={py(t)} y2={py(t)} stroke="var(--border)" strokeWidth={t === 0 ? 1.25 : 1} />
                <text x={m.left - 8} y={py(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--muted-fg)" className="tabular">
                  {formatY(t)}
                </text>
              </g>
            ))}
            {xs.map((v, i) =>
              i % labelEvery === 0 ? (
                <text key={v} x={px(i)} y={H - 10} textAnchor="middle" fontSize="11" fill="var(--muted-fg)">
                  {formatXTick ? formatXTick(v, i) : formatX(v)}
                </text>
              ) : null,
            )}
            {hover != null && <line x1={px(hover)} x2={px(hover)} y1={m.top} y2={m.top + ph} stroke="var(--muted-fg)" strokeDasharray="3 3" strokeWidth="1" />}
            {paths.map((p) => (
              <path key={p.name} d={p.d} fill="none" stroke={color(p.colorIdx)} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {paths.map((p) =>
              p.list.map((v, i) =>
                v == null ? null : (
                  <circle key={`${p.name}-${i}`} cx={px(i)} cy={py(v)} r={hover === i ? 5.5 : 4} fill={color(p.colorIdx)} stroke="var(--surface)" strokeWidth="2">
                    <title>{`${p.name} · ${formatX(xs[i]!)}: ${formatY(v)}`}</title>
                  </circle>
                ),
              ),
            )}
            {labels.map((l) => (
              <g key={l.name}>
                <line x1={m.left + pw + 6} x2={m.left + pw + 16} y1={l.y} y2={l.y} stroke={color(l.colorIdx)} strokeWidth="2" strokeLinecap="round" />
                <text x={m.left + pw + 20} y={l.y} dy="0.32em" fontSize="11" fontWeight="500" fill="var(--fg)">
                  {shortLabel(l.name)}
                </text>
              </g>
            ))}
          </svg>
        )}
        {hover != null && xs[hover] && (
          <div
            className="pointer-events-none absolute z-10 w-44 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-float"
            style={{ left: tooltipLeft, top: m.top }}
            role="status"
          >
            <div className="mb-1 font-semibold text-fg">{formatX(xs[hover])}</div>
            {paths
              .map((p) => ({ p, v: p.list[hover] }))
              .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))
              .map(({ p, v }) => (
                <div key={p.name} className="flex items-center gap-1.5 py-0.5">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: color(p.colorIdx) }} />
                  <span className="min-w-0 flex-1 truncate text-muted-fg">{shortLabel(p.name)}</span>
                  <span className="tabular font-medium text-fg">{v == null ? '–' : formatY(v)}</span>
                </div>
              ))}
          </div>
        )}
        {!model.hasData && width > 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-fg">Nothing to chart for this period.</div>
        )}
      </div>
    </div>
  );
}
