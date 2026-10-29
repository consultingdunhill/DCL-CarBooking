import type { LatLng } from '@carbooking/core';
import { useMemo, useState } from 'react';
import { MapView, type MapCircle, type MapMarker } from '@/components/map/MapView';
import { cn } from '@/lib/utils';

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Click the map to set a point. Starts centred on the current value, else `center`. */
export function MapPicker({
  value,
  onChange,
  center,
  kind = 'pin',
  circles,
  title,
  className,
  zoom = 17,
}: {
  value: LatLng | null;
  onChange: (p: LatLng) => void;
  center: LatLng;
  kind?: MapMarker['kind'];
  circles?: MapCircle[];
  title?: string;
  className?: string;
  /** Zoom when starting on an existing point. */
  zoom?: number;
}) {
  // Centre once on the starting point; after that the map stays where the admin left it.
  const [start] = useState(() => value);
  const lat = value?.lat;
  const lng = value?.lng;
  const markers = useMemo<MapMarker[]>(
    () => (lat != null && lng != null ? [{ id: 'picked', position: { lat, lng }, kind, title }] : []),
    [lat, lng, kind, title],
  );
  return (
    <div className={cn('relative h-56 overflow-hidden rounded-xl border border-border', className)}>
      <MapView
        center={start ?? center}
        zoom={start ? zoom : 13}
        markers={markers}
        circles={circles}
        onClick={(p) => onChange({ lat: round6(p.lat), lng: round6(p.lng) })}
      />
    </div>
  );
}
