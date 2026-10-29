import { decodePolyline, shortName, type LatLng } from '@carbooking/core';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Circle, CircleCheck, Crosshair, Gauge, MapPin, Maximize2, Users, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CloseTripDialog } from '@/components/ops/CloseTripDialog';
import { ContactButtons } from '@/components/ops/ContactButtons';
import { useMediaQuery, useNow } from '@/components/ops/hooks';
import { clock, dueBack, trackingText } from '@/components/ops/tracking';
import { MapView, STATUS_COLORS, type MapCircle, type MapMarker, type MapPolyline } from '@/components/map/MapView';
import { Badge, TrackingBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton, Spinner } from '@/components/ui/misc';
import { get } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useReference } from '@/lib/queries';
import type { LiveSnapshot } from '@/lib/types';
import { cn } from '@/lib/utils';

type LiveTrip = LiveSnapshot['trips'][number];
const NAIROBI = { lat: -1.2864, lng: 36.8172 };

const posOf = (t: LiveTrip): LatLng | null => (t.trip?.lastLat != null && t.trip.lastLng != null ? { lat: t.trip.lastLat, lng: t.trip.lastLng } : null);

function severity(t: LiveTrip, now: number) {
  const s = t.trip?.trackingStatus;
  if (s === 'TRACKING_LOST') return 0;
  if (s === 'LOCATION_OFF') return 1;
  if (s === 'OFFLINE') return 2;
  if (t.status === 'IN_PROGRESS' && now > Date.parse(dueBack(t.trip, t.expectedReturnAt))) return 3;
  if (t.status === 'AWAITING_ODOMETER') return 4;
  return 5;
}

/** Cars at the office and trips out right now, with their tracking state (§4.4, §4.5). */
export function LiveMapPage() {
  const fmt = useFormat();
  const ref = useReference();
  const snap = useQuery({ queryKey: ['live', 'snapshot'], queryFn: () => get<LiveSnapshot>('/live/snapshot'), refetchInterval: 30_000 });
  const now = useNow(30_000);
  const desktop = useMediaQuery('(min-width: 768px)');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [fit, setFit] = useState<{ points: LatLng[]; nonce: number } | null>(null);
  const [closing, setClosing] = useState<LiveTrip | null>(null);

  const data = snap.data;
  const trips = useMemo(() => [...(data?.trips ?? [])].sort((a, b) => severity(a, now) - severity(b, now) || a.startAt.localeCompare(b.startAt)), [data, now]);
  const office = data?.office ?? ref.data?.office ?? null;

  const allPoints = useCallback((): LatLng[] => {
    if (!data) return [];
    const pts: LatLng[] = [{ lat: data.office.lat, lng: data.office.lng }];
    for (const t of data.trips) {
      const p = posOf(t);
      if (p) pts.push(p);
      for (const s of t.stops) pts.push({ lat: s.lat, lng: s.lng });
    }
    return pts;
  }, [data]);

  // Fit once when the data first arrives; afterwards only when asked, so live updates don't yank the map.
  useEffect(() => {
    if (data && !fit) setFit({ points: allPoints(), nonce: 0 });
  }, [data, fit, allPoints]);

  const showAll = () => {
    setFocusId(null);
    setFit((f) => ({ points: allPoints(), nonce: (f?.nonce ?? 0) + 1 }));
  };

  const focus = useCallback(
    (t: LiveTrip, scroll = false) => {
      setFocusId(t.bookingId);
      const p = posOf(t);
      const pts = [...(p ? [p] : []), ...t.stops.map((s) => ({ lat: s.lat, lng: s.lng }))];
      if (!pts.length && data) pts.push({ lat: data.office.lat, lng: data.office.lng });
      setFit((f) => ({ points: pts, nonce: (f?.nonce ?? 0) + 1 }));
      if (scroll) {
        setSheetOpen(true);
        setTimeout(() => document.getElementById(`trip-card-${t.bookingId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
      }
    },
    [data],
  );

  const markers = useMemo<MapMarker[]>(() => {
    if (!data) return [];
    const m: MapMarker[] = [{ id: 'office', kind: 'office', position: { lat: data.office.lat, lng: data.office.lng }, title: `${data.office.name}: ${data.office.address}` }];
    for (const t of data.trips) {
      t.stops.forEach((s, i) => {
        const state = s.status === 'DEPARTED' ? ' (visited)' : s.status === 'ARRIVED' ? ' (there now)' : s.status === 'SKIPPED' ? ' (skipped)' : '';
        m.push({ id: `stop-${t.bookingId}-${s.id}`, kind: 'stop', label: String(i + 1), position: { lat: s.lat, lng: s.lng }, title: `${t.car.registration}, stop ${i + 1}: ${s.label || s.address}${state}` });
      });
    }
    for (const t of data.trips) {
      const p = posOf(t);
      if (!p || !t.trip) continue;
      m.push({
        id: `car-${t.bookingId}`,
        kind: 'car',
        label: t.car.registration,
        color: STATUS_COLORS[t.trip.trackingStatus],
        position: p,
        title: `${t.car.registration} · ${t.owner.name}`,
        onClick: () => focus(t, true),
      });
    }
    return m;
  }, [data, focus]);

  const polylines = useMemo<MapPolyline[]>(
    () =>
      (data?.trips ?? [])
        .filter((t) => t.plannedPolyline)
        .map((t) => {
          const focused = focusId === t.bookingId;
          return {
            id: `route-${t.bookingId}`,
            path: decodePolyline(t.plannedPolyline!),
            color: '#0f5e57',
            dashed: true,
            weight: focused ? 4 : 3,
            opacity: focusId && !focused ? 0.3 : 0.75,
          };
        }),
    [data, focusId],
  );

  const circles = useMemo<MapCircle[]>(
    () =>
      data
        ? [
            { id: 'wakeup', center: { lat: data.office.lat, lng: data.office.lng }, radiusM: data.office.wakeupRadiusM, color: '#1f4fbf' },
            { id: 'arrival', center: { lat: data.office.lat, lng: data.office.lng }, radiusM: data.office.arrivalRadiusM, color: '#17803d' },
          ]
        : [],
    [data],
  );

  const fitTo = fit ? (fit.nonce % 2 ? [...fit.points, fit.points[fit.points.length - 1]!] : fit.points) : undefined;
  const fitPadding = desktop ? { top: 60, right: 70, bottom: 50, left: 430 } : { top: 70, right: 40, bottom: 40, left: 40 };

  const panel = (
    <Panel
      snap={snap}
      trips={trips}
      now={now}
      focusId={focusId}
      onFocus={(t) => focus(t)}
      onShowAll={showAll}
      onClose={setClosing}
    />
  );

  return (
    <div className="relative flex h-full min-h-[420px] flex-col overflow-hidden">
      {/* On phones the map ends where the sheet starts, so the map credits (and Google's logo, which must stay visible) aren't covered. */}
      <div className={desktop ? 'absolute inset-0' : 'relative min-h-0 flex-1'}>
        <MapView
          center={office ? { lat: office.lat, lng: office.lng } : NAIROBI}
          zoom={13}
          markers={markers}
          polylines={polylines}
          circles={circles}
          fitTo={fitTo}
          fitPadding={fitPadding}
        />
      </div>

      {snap.isLoading && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <div className="rounded-full bg-surface p-3 shadow-float">
            <Spinner />
          </div>
        </div>
      )}

      <div className="absolute top-3 right-3 z-10 flex gap-2">
        <Button variant="secondary" size="icon" className="shadow-float" onClick={showAll} aria-label="Show everything on the map" title="Show everything">
          <Maximize2 />
        </Button>
      </div>

      {desktop ? (
        <div className="pointer-events-none absolute inset-y-3 left-3 z-10 flex w-[390px] flex-col">
          <div className="pointer-events-auto flex max-h-full min-h-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-float">{panel}</div>
        </div>
      ) : (
        <div className={cn('relative z-10 flex shrink-0 flex-col rounded-t-2xl border-t border-border bg-surface shadow-float', sheetOpen ? 'max-h-[55%]' : '')}>
          <button
            type="button"
            onClick={() => setSheetOpen((o) => !o)}
            className="flex w-full items-center justify-center gap-1 pt-2 pb-1 text-xs text-muted-fg"
            aria-expanded={sheetOpen}
            aria-label={sheetOpen ? 'Collapse the list' : 'Expand the list'}
          >
            <span className="h-1 w-10 rounded-full bg-border" />
            {sheetOpen ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          </button>
          {sheetOpen ? (
            panel
          ) : (
            <button type="button" onClick={() => setSheetOpen(true)} className="px-4 pb-3 text-left text-sm font-medium">
              {summaryLine(snap.data, trips.length)}
            </button>
          )}
        </div>
      )}

      {closing?.trip && (
        <CloseTripDialog
          open
          onOpenChange={(o) => !o && setClosing(null)}
          tripId={closing.trip.id}
          carRegistration={closing.car.registration}
          odometerStart={closing.trip.odometerStart}
          defaultEndHint={closing.trip.officeArrivedAt ? `Leave blank to use when the car got back (${fmt.time(closing.trip.officeArrivedAt)}).` : undefined}
        />
      )}
    </div>
  );
}

function summaryLine(data: LiveSnapshot | undefined, out: number) {
  if (!data) return 'Loading…';
  const atOffice = data.cars.filter((c) => !c.out && c.status === 'AVAILABLE').length;
  return `${out === 0 ? 'No trips out' : `${out} trip${out > 1 ? 's' : ''} out`} · ${atOffice} at the office`;
}

function Panel({
  snap,
  trips,
  now,
  focusId,
  onFocus,
  onShowAll,
  onClose,
}: {
  snap: UseQueryResult<LiveSnapshot>;
  trips: LiveTrip[];
  now: number;
  focusId: string | null;
  onFocus: (t: LiveTrip) => void;
  onShowAll: () => void;
  onClose: (t: LiveTrip) => void;
}) {
  const fmt = useFormat();
  const data = snap.data;
  const atOffice = data?.cars.filter((c) => !c.out && c.status === 'AVAILABLE') ?? [];
  const maintenance = data?.cars.filter((c) => !c.out && c.status === 'MAINTENANCE') ?? [];

  return (
    <>
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 pt-2 pb-3 md:pt-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Live map</h1>
          <p className="text-xs text-muted-fg">
            {summaryLine(data, trips.length)}
            {snap.dataUpdatedAt ? ` · updated ${fmt.time(new Date(snap.dataUpdatedAt))}` : ''}
            {snap.isFetching && !snap.isLoading && <Spinner className="ml-1.5 inline size-3" />}
          </p>
        </div>
        {focusId && (
          <Button size="sm" variant="ghost" onClick={onShowAll}>
            Show all
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3">
        {snap.isError ? (
          <ErrorState error={snap.error} retry={() => void snap.refetch()} />
        ) : snap.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-32" />
            <Skeleton className="h-20" />
          </div>
        ) : (
          <>
            <section aria-label="Trips out now" className="space-y-3">
              {trips.length === 0 ? (
                <EmptyState className="py-6" icon={<MapPin />} title="No trips out right now" description="Trips appear here as soon as the trip owner starts them." />
              ) : (
                trips.map((t) => <TripCard key={t.bookingId} t={t} now={now} focused={focusId === t.bookingId} onFocus={() => onFocus(t)} onClose={() => onClose(t)} />)
              )}
            </section>

            <section>
              <h2 className="mb-1.5 px-1 text-xs font-semibold tracking-wide text-muted-fg uppercase">At the office ({atOffice.length})</h2>
              {atOffice.length === 0 ? (
                <p className="px-1 text-sm text-muted-fg">No cars at the office.</p>
              ) : (
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {atOffice.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="font-medium">{c.registration}</span> <span className="text-muted-fg">· {c.make} {c.model}</span>
                      </span>
                      <span className="tabular flex shrink-0 items-center gap-1 text-xs text-muted-fg" title="Current odometer">
                        <Gauge className="size-3.5" /> {c.currentOdometer.toLocaleString()} km
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {maintenance.length > 0 && (
              <section>
                <h2 className="mb-1.5 px-1 text-xs font-semibold tracking-wide text-muted-fg uppercase">In maintenance ({maintenance.length})</h2>
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {maintenance.map((c) => (
                    <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <Wrench className="size-4 shrink-0 text-warning" />
                      <span className="min-w-0">
                        <span className="font-medium">{c.registration}</span> <span className="text-muted-fg">· {c.make} {c.model}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <p className="px-1 pb-1 text-[11px] leading-relaxed text-muted-fg">
              Rings around the office: the inner one is the arrival zone ({data?.office.arrivalRadiusM} m), the outer one wakes the app on approach ({data?.office.wakeupRadiusM} m).
            </p>
          </>
        )}
      </div>
    </>
  );
}

const STATUS_TEXT_TONE = {
  LIVE: 'text-fg',
  OFFLINE: 'text-warning',
  LOCATION_OFF: 'text-danger',
  TRACKING_LOST: 'text-lost font-medium',
  STOPPED: 'text-muted-fg',
  NOT_STARTED: 'text-muted-fg',
} as const;

function TripCard({ t, now, focused, onFocus, onClose }: { t: LiveTrip; now: number; focused: boolean; onFocus: () => void; onClose: () => void }) {
  const fmt = useFormat();
  const trip = t.trip;
  const eta = dueBack(trip, t.expectedReturnAt);
  const overdue = t.status === 'IN_PROGRESS' && now > Date.parse(eta);
  const extended = Boolean(trip?.etaAt && trip.etaAt > t.expectedReturnAt);
  const status = trip ? trackingText(trip, fmt, now) : { text: 'Waiting for the trip to start tracking' };
  const visited = t.stops.filter((s) => s.status === 'ARRIVED' || s.status === 'DEPARTED').length;
  const shown = t.stops.slice(0, 4);

  return (
    <article
      id={`trip-card-${t.bookingId}`}
      onClick={onFocus}
      className={cn(
        'cursor-pointer rounded-xl border bg-surface p-3 transition-colors',
        focused ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: trip ? STATUS_COLORS[trip.trackingStatus] : STATUS_COLORS.NOT_STARTED }} aria-hidden />
            <span className="font-semibold">{t.car.registration}</span>
            <span className="truncate text-xs text-muted-fg">
              {t.car.make} {t.car.model}
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm">{t.owner.name}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ContactButtons compact phone={t.owner.phone} name={t.owner.name} />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation();
              onFocus();
            }}
            aria-label={`Show ${t.car.registration} on the map`}
            title="Show on map"
          >
            <Crosshair />
          </Button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {trip && t.status === 'IN_PROGRESS' && <TrackingBadge status={trip.trackingStatus} />}
        {overdue && <Badge tone="danger">Overdue</Badge>}
        {t.status === 'AWAITING_ODOMETER' && <Badge tone="warning">Needs odometer</Badge>}
      </div>

      {t.status === 'AWAITING_ODOMETER' ? (
        <p className="mt-1.5 text-sm">
          Back at the office{trip?.officeArrivedAt ? ` since ${clock(fmt, trip.officeArrivedAt, now)}` : ''}. Waiting for the end odometer reading.
        </p>
      ) : (
        <>
          <p className={cn('mt-1.5 text-sm', trip ? STATUS_TEXT_TONE[trip.trackingStatus] : 'text-muted-fg')}>{status.text}</p>
          {status.detail && <p className="text-xs text-muted-fg">{status.detail}</p>}
        </>
      )}

      {t.status === 'IN_PROGRESS' && (
        <p className={cn('tabular mt-1 text-xs', overdue ? 'font-medium text-danger' : 'text-muted-fg')}>
          {overdue ? `Due back ${clock(fmt, eta, now)} (${fmt.relative(eta)})` : `Back by ${clock(fmt, eta, now)}`}
          {extended ? ' · ETA extended' : ''}
          {trip?.lastBattery != null && trip.trackingStatus === 'LIVE' ? ` · battery ${trip.lastBattery}%` : ''}
        </p>
      )}

      {t.stops.length > 0 && (
        <div className="mt-2.5">
          <div className="mb-1 text-xs font-medium text-muted-fg">
            Stops: {visited} of {t.stops.length} visited
          </div>
          <ol className="space-y-1">
            {shown.map((s, i) => (
              <li key={s.id} className="flex items-start gap-1.5 text-xs">
                {s.status === 'DEPARTED' ? (
                  <CircleCheck className="mt-px size-3.5 shrink-0 text-success" aria-label="Visited" />
                ) : s.status === 'ARRIVED' ? (
                  <MapPin className="mt-px size-3.5 shrink-0 text-info" aria-label="There now" />
                ) : (
                  <Circle className="mt-px size-3.5 shrink-0 text-muted-fg" aria-label={s.status === 'SKIPPED' ? 'Skipped' : 'Not yet'} />
                )}
                <span className={cn('min-w-0 flex-1', s.status === 'SKIPPED' && 'text-muted-fg line-through')}>
                  <span className="tabular text-muted-fg">{i + 1}.</span> {s.label || s.address}
                  {s.status === 'ARRIVED' && s.arrivedAt && <span className="tabular text-info"> · there since {fmt.time(s.arrivedAt)}</span>}
                  {s.status === 'DEPARTED' && s.departedAt && <span className="tabular text-muted-fg"> · left {fmt.time(s.departedAt)}</span>}
                </span>
              </li>
            ))}
            {t.stops.length > shown.length && <li className="pl-5 text-xs text-muted-fg">+{t.stops.length - shown.length} more</li>}
          </ol>
        </div>
      )}

      {t.passengers.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-fg">
          <Users className="mt-px size-3.5 shrink-0" />
          With {t.passengers.map((p) => shortName(p.name)).join(', ')}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
        {trip && (
          <Button asChild variant="link" size="sm" className="h-auto px-0">
            <Link to={`/admin/trips/${trip.id}`} onClick={(e) => e.stopPropagation()}>
              Trip detail &amp; timeline →
            </Link>
          </Button>
        )}
        {trip && t.status === 'AWAITING_ODOMETER' && (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            Enter odometer
          </Button>
        )}
      </div>
    </article>
  );
}
