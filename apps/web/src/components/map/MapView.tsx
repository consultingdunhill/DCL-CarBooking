import { lazy, Suspense } from 'react';
import { ENV } from '@/lib/env';
import { Spinner } from '../ui/misc';
import type { MapViewProps } from './types';

export type { MapCircle, MapMarker, MapPolyline, MapViewProps } from './types';

const GoogleMap = lazy(() => import('./GoogleMap'));
const LeafletMap = lazy(() => import('./LeafletMap'));

export const usingGoogleMaps = Boolean(ENV.googleMapsKey);

/** Map with markers, routes and zones: Google Maps when configured, otherwise OpenStreetMap. */
export function MapView(props: MapViewProps) {
  const Impl = usingGoogleMaps ? GoogleMap : LeafletMap;
  return (
    <Suspense
      fallback={
        <div className="flex h-full w-full items-center justify-center bg-muted">
          <Spinner />
        </div>
      }
    >
      <Impl {...props} />
    </Suspense>
  );
}

export const STATUS_COLORS = {
  LIVE: '#17803d',
  OFFLINE: '#c26a0e',
  LOCATION_OFF: '#b4231b',
  TRACKING_LOST: '#2b2f2d',
  STOPPED: '#66706b',
  NOT_STARTED: '#66706b',
} as const;
