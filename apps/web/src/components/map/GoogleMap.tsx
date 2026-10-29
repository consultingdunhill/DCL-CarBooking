import { AdvancedMarker, APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { useEffect } from 'react';
import { ENV } from '@/lib/env';
import { cn } from '@/lib/utils';
import { pinHtml, type MapCircle, type MapPolyline, type MapViewProps } from './types';

function Shapes({ polylines, circles }: { polylines: MapPolyline[]; circles: MapCircle[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    const lines = polylines.map(
      (p) =>
        new google.maps.Polyline({
          map,
          path: p.path,
          strokeColor: p.color ?? '#0f5e57',
          strokeOpacity: p.dashed ? 0 : (p.opacity ?? 0.85),
          strokeWeight: p.weight ?? 4,
          icons: p.dashed ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: p.opacity ?? 0.85, scale: 3 }, offset: '0', repeat: '14px' }] : undefined,
        }),
    );
    const rings = circles.map(
      (c) => new google.maps.Circle({ map, center: c.center, radius: c.radiusM, strokeColor: c.color ?? '#0f5e57', strokeWeight: 1, fillColor: c.color ?? '#0f5e57', fillOpacity: 0.08 }),
    );
    return () => {
      lines.forEach((l) => l.setMap(null));
      rings.forEach((r) => r.setMap(null));
    };
  }, [map, polylines, circles]);
  return null;
}

function Fit({ points, padding }: { points?: MapViewProps['fitTo']; padding?: MapViewProps['fitPadding'] }) {
  const map = useMap();
  const key = points?.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|') ?? '';
  useEffect(() => {
    if (!map || !points || points.length === 0) return;
    const b = new google.maps.LatLngBounds();
    points.forEach((p) => b.extend(p));
    // A single point gets a ~1 km box so the padding (floating panels) still applies.
    if (points.length === 1) {
      const d = 0.0055;
      b.extend({ lat: points[0]!.lat + d, lng: points[0]!.lng + d });
      b.extend({ lat: points[0]!.lat - d, lng: points[0]!.lng - d });
    }
    map.fitBounds(b, padding ?? 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

/** Google Maps JavaScript API (used when VITE_GOOGLE_MAPS_API_KEY is set). */
export default function GoogleMap({ center, zoom = 13, markers = [], polylines = [], circles = [], fitTo, fitPadding, onClick, className }: MapViewProps) {
  return (
    <APIProvider apiKey={ENV.googleMapsKey!} libraries={['places', 'geometry']}>
      <Map
        className={cn('h-full w-full', className)}
        defaultCenter={center}
        defaultZoom={zoom}
        mapId={ENV.googleMapId ?? 'DEMO_MAP_ID'}
        gestureHandling="greedy"
        disableDefaultUI
        clickableIcons={false}
        onClick={(e) => e.detail.latLng && onClick?.(e.detail.latLng)}
      >
        <Shapes polylines={polylines} circles={circles} />
        <Fit points={fitTo} padding={fitPadding} />
        {markers.map((m) => (
          <AdvancedMarker key={m.id} position={m.position} title={m.title} onClick={m.onClick}>
            <div dangerouslySetInnerHTML={{ __html: pinHtml(m) }} />
          </AdvancedMarker>
        ))}
      </Map>
    </APIProvider>
  );
}
