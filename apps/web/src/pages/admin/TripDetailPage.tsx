import { decodePolyline, type LatLng, type TrackingEventType } from '@carbooking/core';
import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
  ArrowLeft,
  BatteryLow,
  Building2,
  CircleCheck,
  Clock,
  ExternalLink,
  Flag,
  Gauge,
  ImageOff,
  LocateFixed,
  LogOut,
  MapPinPen,
  MapPinPlus,
  MapPin,
  MapPinCheck,
  MapPinOff,
  Pause,
  Plane,
  PlaneLanding,
  Play,
  Radar,
  ShieldAlert,
  Signal,
  SignalZero,
  TriangleAlert,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Page } from '@/components/Shell';
import { CloseTripDialog } from '@/components/ops/CloseTripDialog';
import { ContactButtons } from '@/components/ops/ContactButtons';
import { useNow } from '@/components/ops/hooks';
import { clock, dueBack, END_METHOD_LABELS, googleMapsLink, trackingText, type Fmt } from '@/components/ops/tracking';
import { MapView, STATUS_COLORS, type MapMarker, type MapPolyline } from '@/components/map/MapView';
import { Badge, BookingStatusBadge, TrackingBadge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/form';
import { Dl, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { get } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useReference } from '@/lib/queries';
import type { LocationPoint, Stop, TrackingEvent, TripDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

const PLANNED_COLOR = '#66706b';
const ACTUAL_COLOR = '#0f5e57';
const GAP_COLOR = '#c26a0e';
const GAP_MS = 10 * 60_000; // a hole in the GPS track longer than this is drawn as a dashed jump
const IDLE_SKIP_MS = 30_000; // replay fast-forwards through idle stretches longer than this

const upperBound = (arr: number[], t: number) => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

type Speed = '20' | '60' | '240';

/** Admin trip detail: planned vs actual route with replay, stops, event timeline, odometer and photos. */
export function TripDetailPage() {
  const { tripId } = useParams();
  const fmt = useFormat();
  const now = useNow(30_000);
  const trip = useQuery({
    queryKey: ['trip', tripId],
    queryFn: () => get<TripDetail>(`/trips/${tripId}`),
    enabled: Boolean(tripId),
    refetchInterval: (q) => (['IN_PROGRESS', 'AWAITING_ODOMETER'].includes(q.state.data?.booking.status ?? '') ? 60_000 : false),
  });
  const [closeOpen, setCloseOpen] = useState(false);
  const [idx, setIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  if (trip.isError) {
    return (
      <Page wide>
        <BackLink />
        <ErrorState error={trip.error} retry={() => void trip.refetch()} />
      </Page>
    );
  }
  if (trip.isLoading || !trip.data) {
    return (
      <Page wide>
        <BackLink />
        <Skeleton className="mb-2 h-8 w-64" />
        <Skeleton className="mb-6 h-4 w-48" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Skeleton className="h-[440px]" />
          <div className="space-y-4">
            <Skeleton className="h-40" />
            <Skeleton className="h-56" />
          </div>
        </div>
      </Page>
    );
  }

  const t = trip.data;
  const b = t.booking;
  const running = b.status === 'IN_PROGRESS' || b.status === 'AWAITING_ODOMETER';
  const eta = dueBack(t, b.expectedReturnAt);
  const overdue = b.status === 'IN_PROGRESS' && now > Date.parse(eta);
  const flagged = t.variancePct != null && t.variancePct > t.varianceThresholdPct;

  return (
    <Page wide>
      <BackLink />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {b.car.registration}
            <span className="font-normal text-muted-fg">·</span>
            <span>{b.owner.name}</span>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="tabular">{fmt.when(t.startedAt, t.endedAt ?? eta)}</span>
            <BookingStatusBadge status={b.status} />
            {b.status === 'IN_PROGRESS' && <TrackingBadge status={t.trackingStatus} />}
            {overdue && <Badge tone="danger">Overdue</Badge>}
            {flagged && (
              <Badge tone="warning">
                <TriangleAlert className="size-3" /> Odometer vs GPS
              </Badge>
            )}
          </span>
        }
        actions={
          <>
            <Button asChild variant="secondary">
              <Link to={`/trips/${b.id}`}>Booking</Link>
            </Button>
            {running && <Button onClick={() => setCloseOpen(true)}>Close trip</Button>}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr] lg:items-start">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <RouteCard t={t} idx={idx} setIdx={setIdx} playing={playing} setPlaying={setPlaying} />
        </div>
        <div className="space-y-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <SummaryCards t={t} now={now} />
        </div>
        <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-2">
          <StopsCard t={t} />
          <TimelineCard
            t={t}
            onJump={
              t.points.length
                ? (at) => {
                    const times = t.points.map((p) => Date.parse(p.recordedAt));
                    setPlaying(false);
                    setIdx(Math.max(0, Math.min(times.length - 1, upperBound(times, Date.parse(at)) - 1)));
                    document.getElementById('route-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  }
                : undefined
            }
          />
        </div>
      </div>

      {running && (
        <CloseTripDialog
          open={closeOpen}
          onOpenChange={setCloseOpen}
          tripId={t.id}
          carRegistration={b.car.registration}
          odometerStart={t.odometerStart}
          defaultEndHint={
            t.officeArrivedAt
              ? `Leave blank to use when the car got back to the office (${clock(fmt, t.officeArrivedAt, now)}).`
              : t.lastSeenAt
                ? `Leave blank to use when the phone was last seen (${clock(fmt, t.lastSeenAt, now)}).`
                : undefined
          }
        />
      )}
    </Page>
  );
}

function BackLink() {
  return (
    <Link to="/admin/trips" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-fg hover:text-fg">
      <ArrowLeft className="size-4" /> Trip history
    </Link>
  );
}

const activeStops = (stops: Stop[]) => stops.filter((s) => s.status !== 'REJECTED' && s.status !== 'PROPOSED').sort((a, b) => a.seq - b.seq);

// ── Map + replay ──────────────────────────────────────────────────────────────

function RouteCard({
  t,
  idx,
  setIdx,
  playing,
  setPlaying,
}: {
  t: TripDetail;
  idx: number | null;
  setIdx: (i: number | null) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
}) {
  const fmt = useFormat();
  const office = useReference().data?.office ?? null;
  const [speed, setSpeed] = useState<Speed>('20');
  const points = t.points;
  const times = useMemo(() => points.map((p) => Date.parse(p.recordedAt)), [points]);
  const stops = useMemo(() => activeStops(t.booking.stops), [t.booking.stops]);
  const planned = useMemo(() => (t.booking.plannedPolyline ? decodePolyline(t.booking.plannedPolyline) : []), [t.booking.plannedPolyline]);

  const polylines = useMemo<MapPolyline[]>(() => {
    const lines: MapPolyline[] = [];
    if (planned.length) lines.push({ id: 'planned', path: planned, color: PLANNED_COLOR, dashed: true, weight: 4, opacity: 0.7 });
    let seg: LatLng[] = [];
    let n = 0;
    points.forEach((p, i) => {
      if (i > 0 && times[i]! - times[i - 1]! > GAP_MS) {
        if (seg.length > 1) lines.push({ id: `actual-${n++}`, path: seg, color: ACTUAL_COLOR, weight: 4, opacity: 0.9 });
        const prev = points[i - 1]!;
        lines.push({ id: `gap-${i}`, path: [{ lat: prev.lat, lng: prev.lng }, { lat: p.lat, lng: p.lng }], color: GAP_COLOR, dashed: true, weight: 3, opacity: 0.9 });
        seg = [];
      }
      seg.push({ lat: p.lat, lng: p.lng });
    });
    if (seg.length > 1) lines.push({ id: `actual-${n}`, path: seg, color: ACTUAL_COLOR, weight: 4, opacity: 0.9 });
    return lines;
  }, [planned, points, times]);

  const staticMarkers = useMemo<MapMarker[]>(() => {
    const m: MapMarker[] = [];
    if (office) m.push({ id: 'office', kind: 'office', position: { lat: office.lat, lng: office.lng }, title: office.name });
    stops.forEach((s, i) => m.push({ id: `stop-${s.id}`, kind: 'stop', label: String(i + 1), position: { lat: s.lat, lng: s.lng }, title: `Stop ${i + 1}: ${s.label || s.address}` }));
    for (const e of t.events) {
      if (e.lat == null || e.lng == null) continue;
      const color = e.type === 'LOCATION_OFF' ? STATUS_COLORS.LOCATION_OFF : e.type === 'TRACKING_LOST' ? STATUS_COLORS.TRACKING_LOST : e.type === 'OFFLINE' ? STATUS_COLORS.OFFLINE : null;
      if (color) m.push({ id: `ev-${e.id}`, kind: 'dot', color, position: { lat: e.lat, lng: e.lng }, title: `${EVENT_TITLES[e.type]} at ${fmt.time(e.occurredAt)}` });
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [office, stops, t.events]);

  const cur: LocationPoint | null = idx != null ? (points[idx] ?? null) : null;
  const markers = useMemo<MapMarker[]>(() => {
    if (cur) return [...staticMarkers, { id: 'replay', kind: 'car', position: { lat: cur.lat, lng: cur.lng }, color: ACTUAL_COLOR, label: fmt.time(cur.recordedAt), title: 'Replay position' }];
    if (t.lastLat != null && t.lastLng != null) {
      return [...staticMarkers, { id: 'last', kind: 'car', position: { lat: t.lastLat, lng: t.lastLng }, color: STATUS_COLORS[t.trackingStatus], label: t.booking.car.registration, title: 'Final known location' }];
    }
    return staticMarkers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticMarkers, cur, t.lastLat, t.lastLng, t.trackingStatus]);

  const allPoints = useMemo<LatLng[]>(() => {
    const pts: LatLng[] = points.map((p) => ({ lat: p.lat, lng: p.lng }));
    stops.forEach((s) => pts.push({ lat: s.lat, lng: s.lng }));
    if (!pts.length) planned.forEach((p) => pts.push(p));
    if (office) pts.push({ lat: office.lat, lng: office.lng });
    return pts;
  }, [points, stops, planned, office]);
  const [fit, setFit] = useState<{ pts: LatLng[]; nonce: number } | null>(null);
  useEffect(() => {
    if (!fit && allPoints.length) setFit({ pts: allPoints, nonce: 0 });
  }, [fit, allPoints]);
  const fitTo = fit ? (fit.nonce % 2 ? [...fit.pts, fit.pts[fit.pts.length - 1]!] : fit.pts) : undefined;

  // Replay: advance a virtual clock at `speed`× real time.
  useEffect(() => {
    if (!playing || times.length < 2) return;
    let start = idx == null || idx >= times.length - 1 ? 0 : idx;
    if (start !== idx) setIdx(start);
    let virtual = times[start]!;
    let last = performance.now();
    let raf = 0;
    const tick = (ts: number) => {
      const dt = ts - last;
      last = ts;
      virtual += dt * Number(speed);
      const next = times[start + 1];
      if (next != null && next - virtual > IDLE_SKIP_MS) virtual = next - IDLE_SKIP_MS;
      const i = upperBound(times, virtual) - 1;
      if (i >= times.length - 1) {
        setIdx(times.length - 1);
        setPlaying(false);
        return;
      }
      if (i !== start) {
        start = i;
        setIdx(i);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, times]);

  const center = office ? { lat: office.lat, lng: office.lng } : (allPoints[0] ?? { lat: -1.2864, lng: 36.8172 });
  const elapsedMin = cur ? (Date.parse(cur.recordedAt) - Date.parse(t.startedAt)) / 60_000 : null;

  return (
    <Card id="route-card" className="overflow-hidden">
      <div className="relative h-[320px] sm:h-[440px]">
        <MapView center={center} zoom={13} markers={markers} polylines={polylines} fitTo={fitTo} />
        <Button
          variant="secondary"
          size="icon-sm"
          className="absolute top-3 right-3 z-10 shadow-float"
          onClick={() => setFit((f) => ({ pts: allPoints, nonce: (f?.nonce ?? 0) + 1 }))}
          aria-label="Fit the whole route"
          title="Fit the whole route"
        >
          <LocateFixed />
        </Button>
      </div>

      <div className="border-t border-border px-4 py-3">
        {points.length < 2 ? (
          <p className="text-sm text-muted-fg">{points.length === 0 ? 'No GPS points were recorded for this trip.' : 'Only one GPS point was recorded, so there is nothing to replay.'}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Button
                size="icon"
                onClick={() => setPlaying(!playing)}
                aria-label={playing ? 'Pause replay' : 'Play replay'}
                title={playing ? 'Pause' : 'Play'}
              >
                {playing ? <Pause /> : <Play />}
              </Button>
              <input
                type="range"
                min={0}
                max={points.length - 1}
                step={1}
                value={idx ?? 0}
                onChange={(e) => {
                  setPlaying(false);
                  setIdx(Number(e.target.value));
                }}
                className="h-2 min-w-0 flex-1 cursor-pointer accent-[var(--primary)]"
                aria-label="Replay position"
                aria-valuetext={cur ? fmt.dateTime(cur.recordedAt) : 'Start'}
              />
              <Segmented<Speed>
                value={speed}
                onChange={setSpeed}
                className="hidden sm:inline-flex"
                options={[
                  { value: '20', label: '20×' },
                  { value: '60', label: '60×' },
                  { value: '240', label: '240×' },
                ]}
              />
            </div>
            <div className="tabular flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
              {cur ? (
                <>
                  <span className="font-semibold">{fmt.time(cur.recordedAt)}</span>
                  {elapsedMin != null && <span className="text-muted-fg">+{fmt.duration(elapsedMin)} into the trip</span>}
                  <span>
                    <span className="text-muted-fg">Speed </span>
                    {cur.speed != null ? `${Math.round(cur.speed * 3.6)} km/h` : '–'}
                  </span>
                  <span>
                    <span className="text-muted-fg">Battery </span>
                    {cur.battery != null ? `${cur.battery}%` : '–'}
                  </span>
                  {cur.accuracy != null && <span className="text-muted-fg">±{Math.round(cur.accuracy)} m</span>}
                  <Button variant="link" size="sm" className="ml-auto h-auto px-0" onClick={() => {
                      setPlaying(false);
                      setIdx(null);
                    }}>
                    Reset
                  </Button>
                </>
              ) : (
                <span className="text-muted-fg">
                  Press play to replay the {points.length.toLocaleString()} GPS points ({fmt.time(points[0]!.recordedAt)}–{fmt.time(points[points.length - 1]!.recordedAt)}).
                </span>
              )}
              <Segmented<Speed>
                value={speed}
                onChange={setSpeed}
                className="sm:hidden"
                options={[
                  { value: '20', label: '20×' },
                  { value: '60', label: '60×' },
                  { value: '240', label: '240×' },
                ]}
              />
            </div>
          </div>
        )}
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-fg" aria-label="Map legend">
          <li className="flex items-center gap-1.5">
            <span className="w-5 border-t-[3px] border-dashed" style={{ borderColor: PLANNED_COLOR }} /> Planned route
          </li>
          <li className="flex items-center gap-1.5">
            <span className="w-5 border-t-[3px]" style={{ borderColor: ACTUAL_COLOR }} /> Actual GPS track
          </li>
          {polylines.some((p) => p.id.startsWith('gap-')) && (
            <li className="flex items-center gap-1.5">
              <span className="w-5 border-t-[3px] border-dashed" style={{ borderColor: GAP_COLOR }} /> No GPS for 10+ min
            </li>
          )}
          <li className="flex items-center gap-1.5">
            <span className="grid size-4 place-items-center rounded-full bg-primary text-[9px] font-semibold text-white">1</span> Stops
          </li>
        </ul>
      </div>
    </Card>
  );
}

// ── Stops ─────────────────────────────────────────────────────────────────────

function StopsCard({ t }: { t: TripDetail }) {
  const fmt = useFormat();
  const stops = activeStops(t.booking.stops);
  return (
    <Card>
      <CardHeader title="Stops" description={`${stops.filter((s) => s.arrivedAt).length} of ${stops.length} visited`} />
      {stops.length === 0 ? (
        <EmptyState title="No stops on this trip" className="py-8" />
      ) : (
        <ol className="divide-y divide-border">
          {stops.map((s, i) => {
            const dwell = s.arrivedAt && s.departedAt ? (Date.parse(s.departedAt) - Date.parse(s.arrivedAt)) / 60_000 : null;
            return (
              <li key={s.id} className="flex gap-3 px-5 py-3">
                <span className={cn('tabular mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold', s.arrivedAt ? 'bg-primary text-primary-fg' : 'bg-muted text-muted-fg')}>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <div className="min-w-0">
                      <div className="font-medium">{s.label || s.address}</div>
                      {s.label && <div className="text-sm text-muted-fg">{s.address}</div>}
                      <div className="mt-0.5 text-xs text-muted-fg">
                        {s.reason.label}
                        {s.crmLeadName && ` · for ${s.crmLeadName} (CRM lead ${s.crmLeadRef})`}
                        {s.property && ` · ${s.property.ref}${s.property.client ? ` (${s.property.client.name})` : ''}`}
                        {s.addedBy.id !== t.booking.ownerId && ` · added by ${s.addedBy.name}`}
                      </div>
                    </div>
                    {s.status === 'SKIPPED' ? <Badge>Skipped</Badge> : !s.arrivedAt ? <Badge>Not visited</Badge> : null}
                  </div>
                  {(s.arrivedAt || s.departedAt) && (
                    <div className="tabular mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      <span>
                        <span className="text-muted-fg">Arrived </span>
                        {s.arrivedAt ? fmt.time(s.arrivedAt) : '–'}
                      </span>
                      <span>
                        <span className="text-muted-fg">Left </span>
                        {s.departedAt ? fmt.time(s.departedAt) : '–'}
                      </span>
                      {dwell != null && (
                        <span>
                          <span className="text-muted-fg">Time there </span>
                          {fmt.duration(dwell)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

// ── Event timeline ────────────────────────────────────────────────────────────

const EVENT_TITLES: Record<TrackingEventType, string> = {
  TRIP_STARTED: 'Trip started',
  TRIP_ENDED: 'Trip ended',
  LOCATION_OFF: 'Location turned OFF',
  LOCATION_ON: 'Location back ON',
  PERMISSION_CHANGED: 'Location permission changed',
  OFFLINE: 'Phone offline',
  ONLINE: 'Phone back online',
  AIRPLANE_MODE_ON: 'Airplane mode on',
  AIRPLANE_MODE_OFF: 'Airplane mode off',
  HEARTBEAT_MISSED: 'Heartbeat missed',
  TRACKING_LOST: 'Tracking lost',
  TRACKING_RESUMED: 'Tracking resumed',
  GEOFENCE_ENTER: 'Entered the office zone',
  GEOFENCE_EXIT: 'Left the office zone',
  OFFICE_ARRIVED: 'Back at the office',
  STOP_ARRIVED: 'Arrived at stop',
  STOP_DEPARTED: 'Left stop',
  STOP_ADDED: 'Stop added',
  STOP_CHANGED: 'Stop changed',
  OVERDUE: 'Overdue',
  ETA_EXTENDED: 'Return time extended',
  LOW_BATTERY: 'Phone battery low',
  AWAITING_ODOMETER: 'Waiting for odometer reading',
};

const EVENT_ICON: Record<TrackingEventType, LucideIcon> = {
  TRIP_STARTED: Play,
  TRIP_ENDED: Flag,
  LOCATION_OFF: MapPinOff,
  LOCATION_ON: MapPin,
  PERMISSION_CHANGED: ShieldAlert,
  OFFLINE: WifiOff,
  ONLINE: Wifi,
  AIRPLANE_MODE_ON: Plane,
  AIRPLANE_MODE_OFF: PlaneLanding,
  HEARTBEAT_MISSED: SignalZero,
  TRACKING_LOST: SignalZero,
  TRACKING_RESUMED: Signal,
  GEOFENCE_ENTER: Radar,
  GEOFENCE_EXIT: Radar,
  OFFICE_ARRIVED: Building2,
  STOP_ARRIVED: MapPinCheck,
  STOP_DEPARTED: LogOut,
  STOP_ADDED: MapPinPlus,
  STOP_CHANGED: MapPinPen,
  OVERDUE: AlarmClock,
  ETA_EXTENDED: Clock,
  LOW_BATTERY: BatteryLow,
  AWAITING_ODOMETER: Gauge,
};

const TONE_BUBBLE: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-fg',
  primary: 'bg-accent text-accent-fg',
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-danger',
  info: 'bg-info-bg text-info',
  lost: 'bg-lost-bg text-lost',
};

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const numv = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function describeEvent(e: TrackingEvent, t: TripDetail, fmt: Fmt, stopNo: (d: Record<string, unknown>) => { n: number | null; name: string | null }): { text: string; tone: Tone; sub?: string } {
  const d = e.details ?? {};
  const address = str(d.address);
  const near = address ? ` near ${address}` : '';
  switch (e.type) {
    case 'TRIP_STARTED': {
      const odo = numv(d.odometer) ?? t.odometerStart;
      const unlogged = numv(d.unloggedKm) ?? t.unloggedKm;
      return { text: `Trip started at ${odo.toLocaleString()} km`, tone: 'primary', sub: unlogged > 0 ? `${unlogged.toLocaleString()} km unlogged since the car's last recorded reading` : undefined };
    }
    case 'TRIP_ENDED': {
      const method = (str(d.method) ?? t.endMethod) as keyof typeof END_METHOD_LABELS | null;
      const odo = numv(d.odometer) ?? t.odometerEnd;
      const how = method === 'GEOFENCE' ? 'on arrival at the office' : method === 'ADMIN' ? 'closed by an admin' : method === 'MANUAL' ? 'by the trip owner' : '';
      return { text: `Trip ended${how ? ` ${how}` : ''}${odo != null ? ` at ${odo.toLocaleString()} km` : ''}`, tone: 'primary', sub: method === 'ADMIN' && t.endNote ? `Note: ${t.endNote}` : undefined };
    }
    case 'LOCATION_OFF':
      return { text: `Location turned OFF${near}`, tone: 'danger' };
    case 'LOCATION_ON':
      return { text: 'Location back ON', tone: 'success', sub: str(d.inferred) ? 'Inferred: GPS fixes resumed' : undefined };
    case 'PERMISSION_CHANGED':
      if (d.always === false) return { text: 'Location permission downgraded from “Always”', tone: 'danger', sub: str(d.status) ?? undefined };
      if (d.always === true) return { text: 'Location permission set back to “Always”', tone: 'success' };
      return { text: 'Location permission changed', tone: 'warning', sub: str(d.status) ?? undefined };
    case 'OFFLINE':
      return { text: e.source === 'DEVICE' ? 'Phone lost its connection' : `No contact from the phone${near}`, tone: 'warning' };
    case 'ONLINE':
      return { text: 'Phone back online', tone: 'success' };
    case 'AIRPLANE_MODE_ON':
      return { text: 'Airplane mode turned on', tone: 'warning' };
    case 'AIRPLANE_MODE_OFF':
      return { text: 'Airplane mode turned off', tone: 'success' };
    case 'HEARTBEAT_MISSED':
      return { text: 'Heartbeat missed', tone: 'warning' };
    case 'TRACKING_LOST': {
      const seen = str(d.lastSeenAt);
      const battery = numv(d.battery);
      return {
        text: `Tracking lost${seen ? `, last seen ${fmt.time(seen)}` : ''}${address ? ` at ${address}` : ''}${battery != null ? `, battery ${battery}%` : ''}`,
        tone: 'lost',
      };
    }
    case 'TRACKING_RESUMED':
      return { text: 'Tracking resumed, back in contact', tone: 'success' };
    case 'GEOFENCE_ENTER':
      return { text: `Entered the ${str(d.identifier) ?? 'office wake-up'} zone`, tone: 'neutral' };
    case 'GEOFENCE_EXIT':
      return { text: `Left the ${str(d.identifier) ?? 'office wake-up'} zone`, tone: 'neutral' };
    case 'OFFICE_ARRIVED':
      return { text: 'Back at the office', tone: 'info' };
    case 'STOP_ARRIVED':
    case 'STOP_DEPARTED': {
      const { n, name } = stopNo(d);
      const verb = e.type === 'STOP_ARRIVED' ? 'Arrived at' : 'Left';
      return {
        text: `${verb} stop${n != null ? ` ${n}` : ''}${name ? `: ${name}` : ''}`,
        tone: 'info',
        sub: d.manual === true ? 'Marked by the trip owner' : e.source === 'SERVER' ? 'Detected from GPS' : undefined,
      };
    }
    case 'STOP_ADDED':
      return { text: `Stop added during the trip: ${str(d.address) ?? 'new stop'}`, tone: 'warning', sub: str(d.by) ? `By ${str(d.by)}` : undefined };
    case 'STOP_CHANGED':
      return { text: `Stop changed: ${str(d.from) ?? 'stop'} → ${str(d.to) ?? 'new place'}`, tone: 'warning', sub: str(d.by) ? `By ${str(d.by)}` : undefined };
    case 'OVERDUE': {
      const due = str(d.eta);
      const stage = str(d.stage);
      return {
        text: stage === 'admin' ? 'Overdue: admins alerted' : stage === 'owner' ? 'Overdue: trip owner reminded' : 'Overdue',
        tone: 'danger',
        sub: due ? `Was due back at ${fmt.time(due)}` : undefined,
      };
    }
    case 'ETA_EXTENDED': {
      const from = str(d.from);
      const to = str(d.to);
      return { text: from && to ? `Return time extended from ${fmt.time(from)} to ${fmt.time(to)}` : 'Return time extended', tone: 'info' };
    }
    case 'LOW_BATTERY': {
      const battery = numv(d.battery);
      return { text: `Phone battery low${battery != null ? ` (${battery}%)` : ''}`, tone: 'warning' };
    }
    case 'AWAITING_ODOMETER':
      return { text: 'Tracking stopped; waiting for the end odometer reading', tone: 'warning' };
    default:
      return { text: EVENT_TITLES[e.type as TrackingEventType] ?? String(e.type), tone: 'neutral' };
  }
}

const SOURCE_LABELLED: TrackingEventType[] = ['OFFLINE', 'ONLINE'];
const BACKFILLABLE: TrackingEventType[] = ['OFFLINE', 'ONLINE', 'LOCATION_OFF', 'LOCATION_ON', 'AIRPLANE_MODE_ON', 'AIRPLANE_MODE_OFF', 'PERMISSION_CHANGED'];

function TimelineCard({ t, onJump }: { t: TripDetail; onJump?: (at: string) => void }) {
  const fmt = useFormat();
  const stops = activeStops(t.booking.stops);
  const stopNo = (d: Record<string, unknown>) => {
    const idx = typeof d.stopId === 'string' ? stops.findIndex((s) => s.id === d.stopId) : typeof d.seq === 'number' ? stops.findIndex((s) => s.seq === d.seq) : -1;
    const s = idx >= 0 ? stops[idx]! : null;
    return { n: idx >= 0 ? idx + 1 : numv(d.seq), name: s ? s.label || s.address : str(d.address) };
  };
  const startDay = fmt.dateKey(t.startedAt);

  return (
    <Card>
      <CardHeader title="Event timeline" description={onJump ? 'Select an event to move the replay there.' : undefined} />
      {t.events.length === 0 ? (
        <EmptyState title="No events recorded" className="py-8" />
      ) : (
        <ol className="relative px-5 py-4">
          {t.events.map((e, i) => {
            const Icon = EVENT_ICON[e.type] ?? CircleCheck;
            const { text, tone, sub } = describeEvent(e, t, fmt, stopNo);
            const otherDay = fmt.dateKey(e.occurredAt) !== startDay;
            const delayMin = (Date.parse(e.receivedAt) - Date.parse(e.occurredAt)) / 60_000;
            const backfilled = e.source === 'DEVICE' && BACKFILLABLE.includes(e.type) && delayMin > 2 && delayMin < 24 * 60;
            const body: ReactNode = (
              <>
                <span className={cn('relative z-[1] grid size-8 shrink-0 place-items-center rounded-full ring-4 ring-surface [&_svg]:size-4', TONE_BUBBLE[tone])}>
                  <Icon />
                </span>
                <span className="min-w-0 flex-1 pt-1">
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="tabular text-sm font-semibold">{otherDay ? fmt.dateTime(e.occurredAt) : fmt.time(e.occurredAt)}</span>
                    <span className="text-sm">{text}</span>
                    {SOURCE_LABELLED.includes(e.type) && <Badge className="py-0 text-[11px]">{e.source === 'DEVICE' ? 'device-reported' : 'server-detected'}</Badge>}
                  </span>
                  {sub && <span className="block text-xs text-muted-fg">{sub}</span>}
                  {backfilled && <span className="block text-xs text-muted-fg">Sent after reconnecting, at {fmt.time(e.receivedAt)}</span>}
                </span>
              </>
            );
            return (
              <li key={e.id} className="relative pb-4 last:pb-0">
                {i < t.events.length - 1 && <span className="absolute top-8 bottom-0 left-4 w-px -translate-x-1/2 bg-border" aria-hidden />}
                {onJump ? (
                  <button type="button" onClick={() => onJump(e.occurredAt)} className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-lg px-2 py-0.5 text-left hover:bg-muted/60">
                    {body}
                  </button>
                ) : (
                  <div className="flex items-start gap-3">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

function SummaryCards({ t, now }: { t: TripDetail; now: number }) {
  const fmt = useFormat();
  const b = t.booking;
  const running = b.status === 'IN_PROGRESS';
  const status = trackingText(t, fmt, now);
  const flagged = t.variancePct != null && t.variancePct > t.varianceThresholdPct;
  const eta = dueBack(t, b.expectedReturnAt);
  const device = t.device ?? {};
  const deviceText = [str(device.model), str(device.manufacturer), str(device.platform), str(device.osVersion)].filter(Boolean).join(' · ');

  return (
    <>
      <Card>
        <CardHeader title={running ? 'Current location' : 'Final known location'} actions={<TrackingBadge status={t.trackingStatus} />} />
        <CardBody className="space-y-3 text-sm">
          {t.lastLat != null && t.lastLng != null ? (
            <div>
              <div className="font-medium">{t.lastAddress ?? `${t.lastLat.toFixed(5)}, ${t.lastLng.toFixed(5)}`}</div>
              <a href={googleMapsLink(t.lastLat, t.lastLng)} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                Open in Google Maps <ExternalLink className="size-3" />
              </a>
            </div>
          ) : (
            <p className="text-muted-fg">No location recorded.</p>
          )}
          <Dl
            items={[
              ['Last seen', t.lastSeenAt ? <span className="tabular">{`${clock(fmt, t.lastSeenAt, now)} (${fmt.relative(t.lastSeenAt)})`}</span> : '–'],
              ['Battery', t.lastBattery != null ? <span className={cn('tabular', t.lastBattery <= 15 && 'font-medium text-danger')}>{t.lastBattery}%</span> : '–'],
              ['Tracking', status.text],
            ]}
          />
          {status.detail && <p className="text-xs text-muted-fg">{status.detail}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Distance & odometer" />
        <CardBody className="space-y-3">
          <Dl
            className="tabular"
            items={[
              ['Start reading', `${t.odometerStart.toLocaleString()} km`],
              ['End reading', t.odometerEnd != null ? `${t.odometerEnd.toLocaleString()} km` : '–'],
              ['Trip km (odometer)', fmt.km(t.tripKm)],
              ['GPS km', fmt.km(t.gpsDistanceKm)],
              [
                'Variance',
                t.variancePct == null ? (
                  '–'
                ) : flagged ? (
                  <Badge tone="warning">
                    <TriangleAlert className="size-3" /> {t.variancePct.toFixed(1)}%
                  </Badge>
                ) : (
                  `${t.variancePct.toFixed(1)}%`
                ),
              ],
              ['Unlogged km', t.unloggedKm > 0 ? <span className="font-medium text-warning">{t.unloggedKm.toLocaleString()} km</span> : '0 km'],
              ...(b.plannedDistanceKm != null ? ([['Planned', fmt.km(b.plannedDistanceKm)]] as [ReactNode, ReactNode][]) : []),
            ]}
          />
          {flagged && (
            <Callout tone="warning">
              Odometer and GPS distance differ by {t.variancePct!.toFixed(0)}%, more than the {t.varianceThresholdPct}% threshold. Check the odometer photos.
            </Callout>
          )}
          {t.unloggedKm > 0 && (
            <Callout tone="warning">
              {t.unloggedKm.toLocaleString()} km were driven between the car's last recorded reading and this trip's start, with no trip logged.
            </Callout>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Odometer photos" />
        <CardBody className="grid grid-cols-2 gap-3">
          <Photo label="Start" url={t.photoStartUrl} reading={t.odometerStart} />
          <Photo label="End" url={t.photoEndUrl} reading={t.odometerEnd} missing={t.endMethod === 'ADMIN' ? 'Closed by an admin without a photo' : 'Not taken yet'} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Trip" />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-muted-fg">Trip owner</div>
              <div className="font-medium">{b.owner.name}</div>
            </div>
            <ContactButtons phone={b.owner.phone} name={b.owner.name} />
          </div>
          <Dl
            items={[
              ['Car', `${b.car.registration} · ${b.car.make} ${b.car.model}`],
              ['Driver', b.driver.name],
              ['Passengers', b.passengers.length ? b.passengers.map((p) => p.user.name).join(', ') : 'None'],
              ['Booked', <span className="tabular">{fmt.when(b.startAt, b.expectedReturnAt)}</span>],
              ['Started', <span className="tabular">{fmt.dateTime(t.startedAt)}</span>],
              t.endedAt
                ? ['Ended', <span className="tabular">{`${fmt.dateTime(t.endedAt)}${t.endMethod ? ` · ${END_METHOD_LABELS[t.endMethod]}` : ''}`}</span>]
                : ['Due back', <span className="tabular">{clock(fmt, eta, now)}{t.etaAt && t.etaAt > b.expectedReturnAt ? ' (extended)' : ''}</span>],
              ...(t.officeArrivedAt ? ([['Back at office', <span className="tabular">{fmt.dateTime(t.officeArrivedAt)}</span>]] as [ReactNode, ReactNode][]) : []),
              ...(t.endNote ? ([['End note', t.endNote]] as [ReactNode, ReactNode][]) : []),
              ...(deviceText ? ([['Phone', deviceText]] as [ReactNode, ReactNode][]) : []),
            ]}
          />
          {b.notes && <p className="rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{b.notes}</p>}
        </CardBody>
      </Card>
    </>
  );
}

function Callout({ tone, children }: { tone: 'warning' | 'danger'; children: ReactNode }) {
  return (
    <div className={cn('flex gap-2 rounded-lg px-3 py-2 text-sm', tone === 'warning' ? 'bg-warning-bg text-warning' : 'bg-danger-bg text-danger')}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

function Photo({ label, url, reading, missing = 'No photo' }: { label: string; url: string | null; reading: number | null; missing?: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const caption = `${label}${reading != null ? ` · ${reading.toLocaleString()} km` : ''}`;
  return (
    <figure className="min-w-0">
      {url && !failed ? (
        <button type="button" onClick={() => setOpen(true)} className="block w-full overflow-hidden rounded-lg border border-border bg-muted" aria-label={`Enlarge ${label.toLowerCase()} odometer photo`}>
          <img src={url} alt={`${label} odometer`} loading="lazy" onError={() => setFailed(true)} className="aspect-[4/3] w-full object-cover transition-transform hover:scale-[1.03]" />
        </button>
      ) : (
        <div className="grid aspect-[4/3] w-full place-items-center rounded-lg border border-dashed border-border bg-muted/50 px-2 text-center text-xs text-muted-fg">
          <span className="flex flex-col items-center gap-1">
            <ImageOff className="size-5" />
            {url ? 'Photo unavailable' : missing}
          </span>
        </div>
      )}
      <figcaption className="tabular mt-1.5 text-xs text-muted-fg">{caption}</figcaption>
      {url && (
        <Dialog open={open} onOpenChange={setOpen} title={`${label} odometer photo`} description={reading != null ? `Reading entered: ${reading.toLocaleString()} km` : undefined} size="xl">
          <img src={url} alt={`${label} odometer, full size`} className="mx-auto max-h-[75dvh] w-auto rounded-lg object-contain" />
        </Dialog>
      )}
    </figure>
  );
}
