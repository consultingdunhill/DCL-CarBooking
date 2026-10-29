import L from 'leaflet';
import { useEffect, useMemo } from 'react';
import { Circle, MapContainer, Marker, Polyline, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { cn } from '@/lib/utils';
import { pinHtml, type MapViewProps } from './types';

function ClickHandler({ onClick }: { onClick?: MapViewProps['onClick'] }) {
  useMapEvents({ click: (e) => onClick?.({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

function Fit({ points, padding }: { points?: MapViewProps['fitTo']; padding?: MapViewProps['fitPadding'] }) {
  const map = useMap();
  const key = points?.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|') ?? '';
  useEffect(() => {
    if (!points || points.length === 0) return;
    const pad = padding ?? { top: 40, right: 40, bottom: 40, left: 40 };
    // A single point gets a ~1 km box so the padding (floating panels) still applies.
    const bounds = points.length === 1 ? L.latLng(points[0]!.lat, points[0]!.lng).toBounds(1200) : L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    // The container may have just resized with the same change (a phone sheet growing); fit to its current size.
    map.invalidateSize({ pan: false });
    map.fitBounds(bounds, {
      paddingTopLeft: [pad.left, pad.top],
      paddingBottomRight: [pad.right, pad.bottom],
      maxZoom: 16,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

/** Re-measure when the container is resized (panels opening, orientation change). */
function AutoResize() {
  const map = useMap();
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  return null;
}

/** OpenStreetMap fallback, used when no Google Maps key is configured. */
export default function LeafletMap({ center, zoom = 13, markers = [], polylines = [], circles = [], fitTo, fitPadding, onClick, className }: MapViewProps) {
  const icons = useMemo(() => new Map(markers.map((m) => [m.id, L.divIcon({ html: pinHtml(m), className: 'map-pin', iconSize: [0, 0] })])), [markers]);
  return (
    <MapContainer center={[center.lat, center.lng]} zoom={zoom} zoomControl={false} className={cn('h-full w-full', className)} attributionControl>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' maxZoom={19} />
      <ClickHandler onClick={onClick} />
      <Fit points={fitTo} padding={fitPadding} />
      <AutoResize />
      {circles.map((c) => (
        <Circle key={c.id} center={[c.center.lat, c.center.lng]} radius={c.radiusM} pathOptions={{ color: c.color ?? '#0f5e57', weight: 1, fillOpacity: 0.08 }} />
      ))}
      {polylines.map((p) => (
        <Polyline
          key={p.id}
          positions={p.path.map((x) => [x.lat, x.lng])}
          pathOptions={{ color: p.color ?? '#0f5e57', weight: p.weight ?? 4, opacity: p.opacity ?? 0.85, dashArray: p.dashed ? '6 8' : undefined }}
        />
      ))}
      {markers.map((m) => (
        <Marker key={m.id} position={[m.position.lat, m.position.lng]} icon={icons.get(m.id)!} title={m.title} eventHandlers={m.onClick ? { click: m.onClick } : undefined} />
      ))}
    </MapContainer>
  );
}
