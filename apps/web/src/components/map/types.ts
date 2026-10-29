import type { LatLng } from '@carbooking/core';

export type MarkerKind = 'office' | 'stop' | 'car' | 'pin' | 'dot' | 'proposed';

export interface MapMarker {
  id: string;
  position: LatLng;
  kind: MarkerKind;
  /** Short text inside the pin (stop number, car initials). */
  label?: string;
  /** CSS colour for car/dot markers (e.g. tracking status). */
  color?: string;
  title?: string;
  onClick?: () => void;
}

export interface MapPolyline {
  id: string;
  path: LatLng[];
  color?: string;
  weight?: number;
  dashed?: boolean;
  opacity?: number;
}

export interface MapCircle {
  id: string;
  center: LatLng;
  radiusM: number;
  color?: string;
}

export interface MapViewProps {
  center: LatLng;
  zoom?: number;
  markers?: MapMarker[];
  polylines?: MapPolyline[];
  circles?: MapCircle[];
  /** Fit the view to these points whenever the list changes. */
  fitTo?: LatLng[];
  /** Keep fitted content clear of floating panels (pixels). */
  fitPadding?: { top: number; right: number; bottom: number; left: number };
  onClick?: (p: LatLng) => void;
  className?: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Pin markup shared by the Leaflet and Google implementations. */
export function pinHtml(m: MapMarker): string {
  const label = m.label ? esc(m.label) : '';
  switch (m.kind) {
    case 'office':
      return `<div style="transform:translate(-50%,-50%);width:34px;height:34px;border-radius:10px;background:var(--fg);color:var(--bg);display:grid;place-items:center;box-shadow:0 2px 8px rgb(0 0 0/.3);border:2px solid var(--surface)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/></svg></div>`;
    case 'stop':
    case 'proposed': {
      const bg = m.kind === 'proposed' ? 'var(--warning)' : 'var(--primary)';
      return `<div style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center">
        <div style="min-width:28px;height:28px;padding:0 6px;border-radius:14px;background:${bg};color:#fff;font:600 13px/28px var(--font-sans);text-align:center;box-shadow:0 2px 8px rgb(0 0 0/.3);border:2px solid #fff">${label || '•'}</div>
        <div style="width:2px;height:8px;background:${bg}"></div></div>`;
    }
    case 'car': {
      const color = m.color ?? 'var(--primary)';
      return `<div style="transform:translate(-50%,-50%);display:flex;align-items:center;gap:4px;padding:3px 8px 3px 4px;border-radius:999px;background:var(--surface);box-shadow:0 2px 10px rgb(0 0 0/.25);border:2px solid ${color};white-space:nowrap">
        <span style="width:22px;height:22px;border-radius:50%;background:${color};display:grid;place-items:center">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4"><path d="M5 17h14M6 17v2M18 17v2M4 13l2-6h12l2 6v4H4z"/></svg></span>
        <span style="font:600 12px var(--font-sans);color:var(--fg)">${label}</span></div>`;
    }
    case 'pin':
      return `<div style="transform:translate(-50%,-100%)"><svg width="30" height="40" viewBox="0 0 30 40"><path d="M15 0C6.7 0 0 6.7 0 15c0 11 15 25 15 25s15-14 15-25C30 6.7 23.3 0 15 0z" fill="var(--danger)"/><circle cx="15" cy="15" r="6" fill="#fff"/></svg></div>`;
    case 'dot':
    default:
      return `<div style="transform:translate(-50%,-50%);width:12px;height:12px;border-radius:50%;background:${m.color ?? 'var(--info)'};border:2px solid #fff;box-shadow:0 0 0 1px rgb(0 0 0/.2)"></div>`;
  }
}
