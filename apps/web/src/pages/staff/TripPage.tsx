import { decodePolyline, DEPARTMENT_LABELS, shortName, tripStartWindow } from '@carbooking/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  BatteryWarning,
  CheckCircle2,
  Clock,
  Flag,
  LocateFixed,
  LogIn,
  LogOut,
  MapPin,
  Navigation,
  Pencil,
  Plus,
  ShieldAlert,
  SkipForward,
  Smartphone,
  UserRound,
  Users,
  WifiOff,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ContactButtons } from '@/components/ContactButtons';
import { TripStopDialog } from '@/components/booking/TripStopDialog';
import { MapView, type MapMarker, type MapPolyline } from '@/components/map/MapView';
import { PhotoCapture } from '@/components/PhotoCapture';
import { Page } from '@/components/Shell';
import { Badge, BookingStatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';
import { Dl, ErrorState, PageLoader } from '@/components/ui/misc';
import { ApiError, errorMessage, post, uploadFile } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { canRunTrips, isNative, platform } from '@/lib/env';
import { useFormat } from '@/lib/format';
import { enqueue } from '@/lib/offline-queue';
import { useBooking, useReference } from '@/lib/queries';
import { loadTrackingSession, locationPermission, requestLocationPermission, saveTrackingSession, startTracking, stopTracking, useTrackerState, type LocationPermission } from '@/lib/tracking';
import type { Booking, Stop, TrackingConfig, TripSummary } from '@/lib/types';
import { cn, uid } from '@/lib/utils';

const MINUTE = 60_000;
const activeStops = (b: Booking) => b.stops.filter((s) => s.status !== 'PROPOSED' && s.status !== 'REJECTED');
const offline = (err: unknown) => err instanceof ApiError && err.code === 'NETWORK';

// ── Start ─────────────────────────────────────────────────────────────────────

function PermissionStep({ perm, onRequest }: { perm: LocationPermission | null; onRequest: () => void }) {
  if (perm === 'always') {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-success-bg px-3 py-2 text-sm text-success">
        <CheckCircle2 className="size-4" /> Location is allowed all the time.
      </p>
    );
  }
  return (
    <div className="grid gap-2 rounded-xl border border-warning/40 bg-warning-bg/60 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <ShieldAlert className="size-4 text-warning" /> Allow location "All the time"
      </p>
      <p className="text-muted-fg">
        The trip is tracked until the car is back at the office, even with the phone locked. Tracking stops when the trip ends.
        {platform === 'android' && ' Also turn off battery optimisation for this app so the phone doesn\'t stop tracking.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onRequest}>
          <LocateFixed /> Allow location
        </Button>
        {platform === 'android' && (
          <Button size="sm" variant="secondary" asChild>
            <Link to="/profile#battery">Battery settings guide</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

function StartDialog({ booking, open, onOpenChange }: { booking: Booking; open: boolean; onOpenChange: (o: boolean) => void }) {
  const ref = useReference();
  const qc = useQueryClient();
  const lastReading = ref.data?.cars.find((c) => c.id === booking.carId)?.currentOdometer ?? null;
  const [odometer, setOdometer] = useState('');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [perm, setPerm] = useState<LocationPermission | null>(null);
  const [errors, setErrors] = useState<{ odometer?: string; photo?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) void locationPermission().then(setPerm);
  }, [open]);

  const submit = async () => {
    const reading = Number(odometer);
    const e: typeof errors = {};
    if (!odometer || !Number.isInteger(reading)) e.odometer = 'Enter the reading in whole km';
    else if (lastReading != null && reading < lastReading) e.odometer = `Lower than the car's last reading (${lastReading.toLocaleString()} km). Check the dashboard.`;
    if (!photo) e.photo = 'Take a photo of the dashboard';
    setErrors(e);
    if (Object.keys(e).length) return;
    if (perm !== 'always' && isNative) {
      const p = await requestLocationPermission();
      setPerm(p);
      if (p === 'denied') return toast.error('Location is needed to run the trip.');
    }

    const action = { kind: 'trip.start' as const, bookingId: booking.id, odometer: reading, photo: photo!, clientRequestId: uid(), startedAt: new Date().toISOString() };
    setBusy(true);
    try {
      const photoKey = await uploadFile('ODOMETER_START', photo!);
      const res = await post<{ trip: TripSummary; tracking: TrackingConfig }>(`/bookings/${booking.id}/trip/start`, {
        odometer: reading,
        photoKey,
        clientRequestId: action.clientRequestId,
        startedAt: action.startedAt,
      });
      await saveTrackingSession({ bookingId: booking.id, config: res.tracking });
      await startTracking(res.tracking).catch((err) => toast.error(`Tracking couldn't start: ${errorMessage(err)}`));
      if (res.trip.unloggedKm > 0) toast.info(`${res.trip.unloggedKm} km were driven since the last trip. The admin has been told.`);
      toast.success('Trip started. Drive safely!');
      onOpenChange(false);
    } catch (err) {
      if (offline(err)) {
        await enqueue(action);
        toast.info("You're offline. The trip start is saved and will sync when you're back online.");
        onOpenChange(false);
      } else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['booking', booking.id] });
      void qc.invalidateQueries({ queryKey: ['current-trip'] });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Start trip"
      description={`${booking.car.registration} · ${booking.car.make} ${booking.car.model}`}
      footer={
        <Button size="lg" className="w-full sm:w-auto" loading={busy} onClick={submit}>
          <Navigation /> Start trip
        </Button>
      }
    >
      <div className="grid gap-5">
        <Field label="Start odometer reading (km)" required error={errors.odometer} hint={lastReading != null ? `Last recorded: ${lastReading.toLocaleString()} km` : undefined}>
          {(p) => <Input {...p} inputMode="numeric" pattern="[0-9]*" className="h-12 text-lg tabular" value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/[^0-9]/g, ''))} placeholder="e.g. 84250" />}
        </Field>
        <PhotoCapture value={photo} onChange={setPhoto} error={errors.photo} />
        {isNative && <PermissionStep perm={perm} onRequest={async () => setPerm(await requestLocationPermission())} />}
        <p className="text-xs text-muted-fg">Location is recorded only until you end this trip.</p>
      </div>
    </Dialog>
  );
}

// ── End ───────────────────────────────────────────────────────────────────────

function EndDialog({ booking, trip, open, onOpenChange, method }: { booking: Booking; trip: TripSummary; open: boolean; onOpenChange: (o: boolean) => void; method: 'MANUAL' | 'GEOFENCE' }) {
  const qc = useQueryClient();
  const [odometer, setOdometer] = useState('');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [errors, setErrors] = useState<{ odometer?: string; photo?: string }>({});
  const [busy, setBusy] = useState(false);
  const reading = Number(odometer);
  const km = odometer && Number.isInteger(reading) ? reading - trip.odometerStart : null;

  const submit = async () => {
    const e: typeof errors = {};
    if (!odometer || !Number.isInteger(reading)) e.odometer = 'Enter the reading in whole km';
    else if (reading < trip.odometerStart) e.odometer = `Lower than the start reading (${trip.odometerStart.toLocaleString()} km)`;
    if (!photo) e.photo = 'Take a photo of the dashboard';
    setErrors(e);
    if (Object.keys(e).length) return;
    const action = { kind: 'trip.end' as const, tripId: trip.id, bookingId: booking.id, odometer: reading, photo: photo!, clientRequestId: uid(), endedAt: new Date().toISOString(), method };
    setBusy(true);
    try {
      const photoKey = await uploadFile('ODOMETER_END', photo!);
      await post(`/trips/${trip.id}/end`, { odometer: reading, photoKey, clientRequestId: action.clientRequestId, endedAt: action.endedAt, method });
      await stopTracking();
      toast.success(`Trip ended · ${km} km`);
      onOpenChange(false);
    } catch (err) {
      if (offline(err)) {
        await enqueue(action);
        await stopTracking();
        toast.info("You're offline. The trip end is saved and will sync when you're back online.");
        onOpenChange(false);
      } else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['booking', booking.id] });
      void qc.invalidateQueries({ queryKey: ['current-trip'] });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="End trip"
      description="Enter the reading on the dashboard now that you're back."
      footer={
        <Button size="lg" className="w-full sm:w-auto" loading={busy} onClick={submit}>
          <Flag /> End trip
        </Button>
      }
    >
      <div className="grid gap-5">
        <Field label="End odometer reading (km)" required error={errors.odometer} hint={`Started at ${trip.odometerStart.toLocaleString()} km${km != null && km >= 0 ? ` · this trip: ${km} km` : ''}`}>
          {(p) => <Input {...p} inputMode="numeric" pattern="[0-9]*" className="h-12 text-lg tabular" value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/[^0-9]/g, ''))} />}
        </Field>
        <PhotoCapture value={photo} onChange={setPhoto} error={errors.photo} />
      </div>
    </Dialog>
  );
}

function ExtendDialog({ booking, trip, open, onOpenChange }: { booking: Booking; trip: TripSummary; open: boolean; onOpenChange: (o: boolean) => void }) {
  const fmt = useFormat();
  const qc = useQueryClient();
  const eta = trip.etaAt ?? booking.expectedReturnAt;
  const [time, setTime] = useState(() => fmt.timeKey(new Date(new Date(eta).getTime() + 30 * MINUTE)));
  const m = useMutation({
    mutationFn: () => post<{ clash: unknown }>(`/trips/${trip.id}/extend`, { expectedReturnAt: fmt.toIso(fmt.dateKey(eta), time) }),
    onSuccess: (r) => {
      toast.success(`New ETA ${time}`);
      if (r.clash) toast.warning('That overlaps the next booking. The next person and the admin have been told.');
      onOpenChange(false);
      void qc.invalidateQueries({ queryKey: ['booking', booking.id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Running late?"
      description={`Current ETA ${fmt.time(eta)}`}
      size="sm"
      footer={
        <Button loading={m.isPending} onClick={() => m.mutate()}>
          Update ETA
        </Button>
      }
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          {[15, 30, 60].map((min) => (
            <button key={min} type="button" className="rounded-full border border-border px-3 py-1 text-sm hover:bg-muted" onClick={() => setTime(fmt.timeKey(new Date(new Date(eta).getTime() + min * MINUTE)))}>
              +{min} min
            </button>
          ))}
        </div>
        <Field label="Back at the office by">{(p) => <Input {...p} type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

// ── Stops checklist ───────────────────────────────────────────────────────────

function StopRow({ stop, index, trip, canAct, onEdit }: { stop: Stop; index: number; trip: TripSummary | null; canAct: boolean; onEdit?: () => void }) {
  const fmt = useFormat();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (action: 'ARRIVED' | 'DEPARTED' | 'SKIPPED') => {
    if (!trip) return;
    setBusy(action);
    const at = new Date().toISOString();
    try {
      await post(`/trips/${trip.id}/stops/${stop.id}`, { action, at });
    } catch (err) {
      if (offline(err)) {
        await enqueue({ kind: 'stop.action', tripId: trip.id, stopId: stop.id, action, at });
        toast.info('Saved. It will sync when you\'re back online.');
      } else toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['booking'] });
    }
  };
  const done = stop.status === 'DEPARTED';
  const here = stop.status === 'ARRIVED';
  return (
    <li className="flex gap-3 py-3">
      <span
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold',
          done ? 'bg-success text-white' : here ? 'bg-info text-white' : stop.status === 'SKIPPED' ? 'bg-muted text-muted-fg line-through' : 'bg-primary text-primary-fg',
        )}
      >
        {done ? <CheckCircle2 className="size-4" /> : index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('font-medium', stop.status === 'SKIPPED' && 'text-muted-fg line-through')}>{stop.property ? `${stop.property.ref} · ${stop.property.address}` : (stop.label ?? stop.address)}</p>
        <p className="text-xs text-muted-fg">
          {stop.reason.label} · {DEPARTMENT_LABELS[stop.reason.department]}
          {stop.crmLeadName && ` · for ${stop.crmLeadName}`}
          {stop.property?.client && ` · ${stop.property.client.name}`}
          {` · added by ${shortName(stop.addedBy.name)}`}
        </p>
        {stop.note && <p className="mt-0.5 text-xs text-muted-fg italic">"{stop.note}"</p>}
        {(stop.arrivedAt || stop.departedAt) && (
          <p className="mt-1 text-xs">
            {stop.arrivedAt && <>Arrived {fmt.time(stop.arrivedAt)}</>}
            {stop.departedAt && <> · Left {fmt.time(stop.departedAt)}</>}
          </p>
        )}
        {canAct && !done && stop.status !== 'SKIPPED' && (
          <div className="mt-2 flex flex-wrap gap-2">
            {!here ? (
              <Button size="sm" variant="secondary" loading={busy === 'ARRIVED'} onClick={() => act('ARRIVED')}>
                <LogIn /> Arrived
              </Button>
            ) : (
              <Button size="sm" variant="secondary" loading={busy === 'DEPARTED'} onClick={() => act('DEPARTED')}>
                <LogOut /> Leaving
              </Button>
            )}
            {!here && (
              <Button size="sm" variant="ghost" loading={busy === 'SKIPPED'} onClick={() => act('SKIPPED')}>
                <SkipForward /> Skip
              </Button>
            )}
            {onEdit && stop.status === 'PLANNED' && (
              <Button size="sm" variant="ghost" onClick={onEdit}>
                <Pencil /> Change
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function TripPage() {
  const { bookingId } = useParams();
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const fmt = useFormat();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ref = useReference();
  const q = useBooking(bookingId);
  const tracker = useTrackerState();
  const [dialog, setDialog] = useState<'start' | 'end' | 'extend' | 'cancel' | null>(null);
  const [stopDialog, setStopDialog] = useState<{ open: boolean; stop?: Stop }>({ open: false });
  const [cancelReason, setCancelReason] = useState('');
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const b = q.data;
  const trip = b?.trip ?? null;
  const isOwner = b?.ownerId === me.id;
  const running = b?.status === 'IN_PROGRESS';

  // Keep tracking alive for the trip owner's running trip (e.g. after reopening the app).
  useEffect(() => {
    if (!b || !trip || !isOwner || !canRunTrips) return;
    (async () => {
      const session = await loadTrackingSession();
      if (running && (!session || session.bookingId !== b.id)) {
        try {
          const config = await post<TrackingConfig>(`/trips/${trip.id}/tracking-token`);
          await saveTrackingSession({ bookingId: b.id, config });
          await startTracking(config);
        } catch (err) {
          console.warn('Could not resume tracking', err);
        }
      } else if (!running && session?.bookingId === b.id) {
        await stopTracking();
      }
    })();
  }, [b?.id, b?.status, trip?.id, isOwner, running]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (params.get('end') && b && isOwner && (b.status === 'IN_PROGRESS' || b.status === 'AWAITING_ODOMETER')) {
      setDialog('end');
      setParams({}, { replace: true });
    }
  }, [params, b, isOwner, setParams]);

  const cancel = useMutation({
    mutationFn: () => post(`/bookings/${bookingId}/cancel`, { reason: cancelReason || null }),
    onSuccess: () => {
      toast.success('Trip cancelled');
      setDialog(null);
      void qc.invalidateQueries({ queryKey: ['booking', bookingId] });
      void qc.invalidateQueries({ queryKey: ['bookings'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const markers = useMemo<MapMarker[]>(() => {
    if (!b) return [];
    const list: MapMarker[] = [];
    const office = ref.data?.office;
    if (office) list.push({ id: 'office', position: office, kind: 'office', title: office.name });
    activeStops(b).forEach((s, i) => list.push({ id: s.id, position: s, kind: 'stop', label: String(i + 1), title: s.address }));
    b.stops.filter((s) => s.status === 'PROPOSED').forEach((s) => list.push({ id: s.id, position: s, kind: 'proposed', label: '+', title: `Proposed: ${s.address}` }));
    if (running && isOwner && tracker.lastFix) list.push({ id: 'me', position: tracker.lastFix, kind: 'dot', color: '#1f4fbf', title: 'You' });
    return list;
  }, [b, ref.data?.office, running, isOwner, tracker.lastFix]);
  const polylines = useMemo<MapPolyline[]>(() => (b?.plannedPolyline ? [{ id: 'route', path: decodePolyline(b.plannedPolyline), dashed: true }] : []), [b?.plannedPolyline]);
  const fitTo = useMemo(() => markers.filter((m) => m.id !== 'me').map((m) => m.position), [markers]);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !b) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  const settings = ref.data?.settings;
  const startWindow = settings ? tripStartWindow(new Date(b.startAt), settings) : null;
  const now = Date.now();
  const canStartNow = startWindow ? now >= startWindow.opensAt.getTime() && now <= startWindow.closesAt.getTime() : false;
  const eta = trip?.etaAt ?? b.expectedReturnAt;
  const overdue = running && now > new Date(eta).getTime() + (settings?.overdueGraceMin ?? 15) * MINUTE;
  const myJoin = b.joinRequests.find((j) => j.requester.id === me.id);
  const stops = activeStops(b);

  // ── Main action card ──
  let action: React.ReactNode = null;
  if (b.status === 'PENDING') {
    action = (
      <div className="flex items-start gap-3">
        <Clock className="mt-0.5 size-5 shrink-0 text-warning" />
        <div>
          <p className="font-medium">Waiting for approval</p>
          <p className="text-sm text-muted-fg">Every admin has been notified. You'll get a notification when it's decided.</p>
        </div>
      </div>
    );
  } else if (b.status === 'APPROVED') {
    action = isOwner ? (
      canRunTrips ? (
        <div className="grid gap-3">
          <p className="text-sm text-muted-fg">
            {canStartNow
              ? 'Ready when you are. Enter the odometer reading and take a photo of the dashboard.'
              : startWindow && now < startWindow.opensAt.getTime()
                ? `You can start from ${fmt.time(startWindow.opensAt)} (${settings?.startWindowMin} minutes before the booked time).`
                : `Not started within ${settings?.noShowWindowMin} minutes of the start time, so it will be released as a no-show.`}
          </p>
          <Button size="xl" className="w-full" disabled={!canStartNow} onClick={() => setDialog('start')}>
            <Navigation /> Start trip
          </Button>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <Smartphone className="mt-0.5 size-5 shrink-0 text-primary" />
          <p className="text-sm">
            Start this trip from the <strong>Fleet app on your phone</strong>: it tracks the trip in the background until the car is back at the office.
          </p>
        </div>
      )
    ) : (
      <p className="text-sm">
        Approved. {isOwner ? '' : `${shortName(b.owner.name)} runs this trip; be at the office by ${fmt.time(b.startAt)}.`}
      </p>
    );
  } else if (running) {
    action = isOwner ? (
      <div className="grid gap-3">
        {trip?.officeArrivedAt && (
          <div className="flex items-center gap-3 rounded-xl bg-accent p-3 text-accent-fg">
            <MapPin className="size-5 shrink-0" />
            <p className="flex-1 text-sm font-medium">Back at the office? End the trip and enter the odometer reading.</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className={cn('rounded-xl border p-3', overdue ? 'border-danger/40 bg-danger-bg' : 'border-border')}>
            <p className="text-xs text-muted-fg">ETA</p>
            <p className={cn('text-lg font-semibold tabular', overdue && 'text-danger')}>{fmt.time(eta)}</p>
            <button className="text-xs font-medium text-primary" onClick={() => setDialog('extend')}>
              Running late?
            </button>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted-fg">Tracking</p>
            {canRunTrips ? (
              <>
                <p className={cn('flex items-center gap-1.5 font-semibold', tracker.active ? 'text-success' : 'text-warning')}>
                  <span className={cn('size-2 rounded-full', tracker.active ? 'bg-success' : 'bg-warning')} />
                  {tracker.active ? 'On' : 'Starting…'}
                </p>
                <p className="text-xs text-muted-fg">
                  {tracker.lastSyncAt ? `Synced ${fmt.relative(tracker.lastSyncAt)}` : 'Not synced yet'}
                  {tracker.pendingEvents > 0 && ` · ${tracker.pendingEvents} to send`}
                </p>
              </>
            ) : (
              <p className="text-sm">On your phone</p>
            )}
          </div>
        </div>
        {!navigator.onLine && (
          <p className="flex items-center gap-2 text-xs text-warning">
            <WifiOff className="size-4" /> Offline. The route is saved on the phone and uploads when you're back online.
          </p>
        )}
        <Button size="xl" variant="danger" className="w-full" onClick={() => setDialog('end')}>
          <Flag /> End trip
        </Button>
      </div>
    ) : (
      <p className="text-sm">On the road with {shortName(b.owner.name)}. Back by {fmt.time(eta)}.</p>
    );
  } else if (b.status === 'AWAITING_ODOMETER') {
    action = (
      <div className="grid gap-3">
        <p className="text-sm">The car is back at the office but the trip wasn't ended. {isOwner ? 'Enter the end odometer reading and photo.' : 'Waiting for the trip owner or an admin to enter the reading.'}</p>
        {isOwner && trip && (
          <Button size="xl" className="w-full" onClick={() => setDialog('end')}>
            <Flag /> Enter end reading
          </Button>
        )}
      </div>
    );
  } else if (b.status === 'COMPLETED' && trip) {
    const km = trip.odometerEnd != null ? trip.odometerEnd - trip.odometerStart : null;
    action = (
      <Dl
        items={[
          ['Distance', km != null ? fmt.km(km) : '–'],
          ['Time out', trip.endedAt ? fmt.duration((new Date(trip.endedAt).getTime() - new Date(trip.startedAt).getTime()) / MINUTE) : '–'],
          ['Odometer', `${trip.odometerStart.toLocaleString()} → ${trip.odometerEnd?.toLocaleString() ?? '–'} km`],
          ['Ended', trip.endedAt ? `${fmt.dateTime(trip.endedAt)}${trip.endMethod === 'ADMIN' ? ' (closed by admin)' : ''}` : '–'],
        ]}
      />
    );
  } else if (b.status === 'REJECTED') {
    action = <p className="text-sm">Rejected{b.decidedBy ? ` by ${b.decidedBy.name}` : ''}: {b.rejectionReason}</p>;
  } else if (b.status === 'CANCELLED') {
    action = <p className="text-sm">Cancelled{b.cancelReason ? `: ${b.cancelReason}` : '.'}</p>;
  } else if (b.status === 'NO_SHOW') {
    action = <p className="text-sm">Not started in time, so the car and driver were released.</p>;
  }

  return (
    <div className="lg:grid lg:h-full lg:grid-cols-[1fr_minmax(0,460px)]">
      <div className="relative h-56 sm:h-72 lg:order-2 lg:h-full">
        {ref.data?.office && <MapView center={ref.data.office} markers={markers} polylines={polylines} fitTo={fitTo} />}
      </div>
      <Page className="lg:order-1 lg:overflow-y-auto">
        <button onClick={() => navigate(-1)} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-fg hover:text-fg">
          <ArrowLeft className="size-4" /> Back
        </button>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{fmt.when(b.startAt, b.expectedReturnAt)}</h1>
            <p className="text-sm text-muted-fg">
              {b.car.registration} · {b.car.make} {b.car.model} · driver {b.driver.name}
            </p>
            {b.createdBy && <p className="text-xs text-muted-fg">Booked by {b.createdBy.name} on {b.owner.name}'s behalf</p>}
          </div>
          <div className="flex items-center gap-2">
            {b.urgent && <Badge tone="danger">Urgent</Badge>}
            {overdue && <Badge tone="danger">Overdue</Badge>}
            <BookingStatusBadge status={b.status} />
          </div>
        </div>

        <Card className="mb-4">
          <CardBody>{action}</CardBody>
        </Card>

        {myJoin && (
          <Card className="mb-4 border-warning/40">
            <CardBody className="flex items-center justify-between gap-3">
              <p className="text-sm">Your request to add a stop is waiting for an admin.</p>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  try {
                    await post(`/join-requests/${myJoin.id}/cancel`);
                    void q.refetch();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                Withdraw
              </Button>
            </CardBody>
          </Card>
        )}

        <section className="mb-4">
          <h2 className="mb-1 text-sm font-semibold tracking-wide text-muted-fg uppercase">Stops</h2>
          <ol className="divide-y divide-border">
            {stops.map((s, i) => (
              <StopRow key={s.id} stop={s} index={i} trip={trip} canAct={isOwner && running} onEdit={isOwner && running ? () => setStopDialog({ open: true, stop: s }) : undefined} />
            ))}
          </ol>
          {isOwner && running && (
            <Button size="sm" variant="secondary" className="mt-1" onClick={() => setStopDialog({ open: true })}>
              <Plus /> Add a stop
            </Button>
          )}
          {b.stops.some((s) => s.status === 'PROPOSED') && (
            <p className="mt-2 text-xs text-warning">{b.stops.filter((s) => s.status === 'PROPOSED').length} proposed stop(s) waiting for an admin.</p>
          )}
          {b.plannedDistanceKm != null && (
            <p className="mt-2 text-xs text-muted-fg">
              Planned round trip ~{fmt.km(b.plannedDistanceKm)}
              {b.plannedDurationMin != null && ` · ${fmt.duration(b.plannedDurationMin)} driving`}
            </p>
          )}
        </section>

        <section className="mb-4">
          <h2 className="mb-2 text-sm font-semibold tracking-wide text-muted-fg uppercase">People</h2>
          <ul className="grid gap-3">
            <li className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm">
                <UserRound className="size-4 text-muted-fg" /> {b.owner.name} <Badge>Trip owner</Badge>
              </span>
              {!isOwner && <ContactButtons phone={b.owner.phone} name={b.owner.name} />}
            </li>
            {b.passengers.map((p) => (
              <li key={p.user.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm">
                  <Users className="size-4 text-muted-fg" /> {p.user.name} <Badge>Passenger</Badge>
                </span>
                {p.user.id !== me.id && <ContactButtons phone={p.user.phone} name={p.user.name} />}
              </li>
            ))}
            <li className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm">
                <UserRound className="size-4 text-muted-fg" /> {b.driver.name} <Badge>Driver</Badge>
              </span>
              <ContactButtons phone={b.driver.phone} name={b.driver.name} />
            </li>
            {isOwner &&
              b.joinRequests.map((j) => (
                <li key={j.id} className="rounded-lg bg-warning-bg/60 px-3 py-2 text-sm">
                  {shortName(j.requester.name)} asked to add a stop{j.proposedReturnAt ? ` and return by ${fmt.time(j.proposedReturnAt)}` : ''}. An admin will decide.
                </li>
              ))}
          </ul>
        </section>

        {b.notes && <p className="mb-4 rounded-lg bg-muted px-3 py-2 text-sm">{b.notes}</p>}

        {(b.status === 'PENDING' || b.status === 'APPROVED') && isOwner && (
          <Button variant="danger-outline" onClick={() => setDialog('cancel')}>
            Cancel trip
          </Button>
        )}
        {!isOwner && (b.status === 'PENDING' || b.status === 'APPROVED' || b.status === 'IN_PROGRESS') && !myJoin && !b.passengers.some((p) => p.user.id === me.id) && (
          <Button variant="secondary" onClick={() => navigate(`/?join=${b.id}`)}>
            <Users /> Request to add my stop
          </Button>
        )}
        {trip && isOwner && running && trip.lastBattery != null && trip.lastBattery <= 20 && (
          <p className="mt-4 flex items-center gap-2 text-sm text-warning">
            <BatteryWarning className="size-4" /> Battery {trip.lastBattery}%. Tracking stops if the phone dies.
          </p>
        )}
      </Page>

      {b.status === 'APPROVED' && isOwner && <StartDialog booking={b} open={dialog === 'start'} onOpenChange={(o) => setDialog(o ? 'start' : null)} />}
      {trip && isOwner && <EndDialog booking={b} trip={trip} method={trip.officeArrivedAt ? 'GEOFENCE' : 'MANUAL'} open={dialog === 'end'} onOpenChange={(o) => setDialog(o ? 'end' : null)} />}
      {trip && running && isOwner && (
        <TripStopDialog tripId={trip.id} bookingId={b.id} stop={stopDialog.stop} open={stopDialog.open} onOpenChange={(open) => setStopDialog((d) => ({ ...d, open }))} />
      )}
      {trip && running && <ExtendDialog booking={b} trip={trip} open={dialog === 'extend'} onOpenChange={(o) => setDialog(o ? 'extend' : null)} />}
      <Dialog
        open={dialog === 'cancel'}
        onOpenChange={(o) => setDialog(o ? 'cancel' : null)}
        title="Cancel this trip?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Keep it
            </Button>
            <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel trip
            </Button>
          </>
        }
      >
        <Field label="Reason (optional)">{(p) => <Textarea {...p} rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />}</Field>
        {b.joinRequests.length > 0 && <p className="mt-2 text-sm text-warning">Pending requests to join will be cancelled and those people told.</p>}
      </Dialog>
    </div>
  );
}
