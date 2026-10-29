import { addDaysToDateKey, CRM_PROPERTY_PREFIX, decodePolyline, fmtDuration, shortName, type LatLng, type PropertyService } from '@carbooking/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Car as CarIcon, CheckCircle2, ChevronRight, Clock, Contact, Crosshair, Hand, MapPin, Route, UserRound, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ContactButtons } from '@/components/ContactButtons';
import { InstallBanner } from '@/components/InstallCard';
import { PlaceSearch, type PickedPlace } from '@/components/booking/PlaceSearch';
import { StopList, stopProblem, type DraftStop } from '@/components/booking/StopList';
import { MapView, type MapMarker, type MapPolyline } from '@/components/map/MapView';
import { Badge, BookingStatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/form';
import { EmptyState, PageLoader, Spinner } from '@/components/ui/misc';
import { ApiError, errorMessage, get, post, qs } from '@/lib/api';
import { useAuth, useMe } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBooking, useCurrentTrip, useReference } from '@/lib/queries';
import type { AdminUser, Availability, Booking, CrmLead, RoutePreview, Slot, VisitReason } from '@/lib/types';
import { cn, uid } from '@/lib/utils';

type Step = 'stops' | 'when' | 'car' | 'join';
const QUARTER = 15 * 60_000;
const roundUp = (t: number) => Math.ceil(t / QUARTER) * QUARTER;

const DEPARTMENT_FOR_SERVICE = { SALES: 'SALES', LETTINGS: 'LETTINGS', MANAGEMENT: 'PROPERTY_MANAGEMENT' } as const;

/** The viewing reason for a property's side of the business, else any viewing reason. */
function viewingReasonId(reasons: VisitReason[], service: PropertyService): string {
  const viewings = reasons.filter((r) => r.active && r.countsAsViewing);
  return (viewings.find((r) => r.department === DEPARTMENT_FOR_SERVICE[service]) ?? viewings[0])?.id ?? '';
}

/** "Booking for Priya" when the form was opened from a lead in the CRM. */
function CrmLeadCard({ lead, loading, error }: { lead?: CrmLead; loading: boolean; error: unknown }) {
  if (loading) return <p className="mb-4 flex items-center gap-2 text-sm text-muted-fg bg-amber-400"><Spinner className="size-4" /> Loading the lead from the CRM…</p>;
  if (error) return <p className="mb-4 rounded-xl bg-danger-bg p-3 text-sm text-danger">{errorMessage(error)}</p>;
  if (!lead) return null;
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-info/30 bg-info-bg p-3">
      <Contact className="mt-0.5 size-5 shrink-0 text-info" />
      <div className="min-w-0 text-sm">
        <p className="font-semibold">Viewing for {lead.firstName}</p>
        <p className="text-xs text-muted-fg">
          {lead.serviceLabel}
          {lead.agent && ` · ${lead.agent.name}'s lead`}
        </p>
        {lead.properties.length === 0 && <p className="mt-1 text-xs">No listings are ticked for them in the CRM. Add the stops yourself.</p>}
      </div>
    </div>
  );
}

function useIsDesktop() {
  const [d, setD] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const m = window.matchMedia('(min-width: 1024px)');
    const f = () => setD(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return d;
}

/** "Your trip starts at 10:00" — shown above "Where to?" when there is one. */
function CurrentTripCard() {
  const { data } = useCurrentTrip();
  const fmt = useFormat();
  const b = data?.running ?? data?.next;
  if (!b) return null;
  const running = Boolean(data?.running);
  return (
    <Link to={`/trips/${b.id}`} className={cn('mb-4 flex items-center gap-3 rounded-xl border p-3 transition-colors', running ? 'border-info/30 bg-info-bg' : 'border-border bg-surface-2 hover:bg-muted')}>
      <div className={cn('grid size-10 shrink-0 place-items-center rounded-full', running ? 'bg-info text-white' : 'bg-accent text-accent-fg')}>
        <CarIcon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{running ? (b.status === 'AWAITING_ODOMETER' ? 'Enter your end odometer reading' : 'Trip in progress') : `Next trip · ${fmt.when(b.startAt, b.expectedReturnAt)}`}</p>
        <p className="truncate text-xs text-muted-fg">
          {b.car.registration} · {b.stops.filter((s) => s.status !== 'PROPOSED' && s.status !== 'REJECTED').map((s) => s.label ?? s.address).join(', ')}
        </p>
      </div>
      <ChevronRight className="size-5 text-muted-fg" />
    </Link>
  );
}

function SlotCard({ slot, onJoin }: { slot: Slot; onJoin?: () => void }) {
  return (
    <div className="rounded-xl border border-warning/30 bg-warning-bg/60 p-3">
      <p className="text-sm font-medium">{slot.description}</p>
      <p className="mt-0.5 text-xs text-muted-fg">
        {slot.car.registration} · {slot.status === 'IN_PROGRESS' ? 'out now' : slot.status === 'PENDING' ? 'pending approval' : 'approved'}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ContactButtons phone={slot.owner.phone} name={slot.owner.name} message={`Hi ${slot.owner.name.split(' ')[0]}, could I add a stop to your trip?`} />
        {onJoin && slot.joinable && (
          <Button size="sm" onClick={onJoin}>
            <Users /> Request to add my stop
          </Button>
        )}
      </div>
    </div>
  );
}

export function BookPage() {
  const [params, setParams] = useSearchParams();
  const joinId = params.get('join');
  const crmLeadId = params.get('crmLead');
  const ref = useReference();
  const fmt = useFormat();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const desktop = useIsDesktop();
  const joinTarget = useBooking(joinId ?? undefined);

  const [step, setStep] = useState<Step>(joinId ? 'join' : 'stops');
  const [stops, setStops] = useState<DraftStop[]>([]);
  const [pinMode, setPinMode] = useState(false);
  const [carId, setCarId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [urgent, setUrgent] = useState(false);
  const { isAdmin } = useAuth();
  const me = useMe();
  // Admins can book on someone's behalf; that booking is approved straight away.
  const [ownerId, setOwnerId] = useState('');
  const staff = useQuery({ queryKey: ['admin', 'users'], queryFn: () => get<AdminUser[]>('/admin/users'), enabled: isAdmin });
  const bookingFor = staff.data?.find((u) => u.id === ownerId && u.id !== me.id) ?? null;
  const [joinReturn, setJoinReturn] = useState('');

  // Opened from "Book a car" on a lead in the CRM: its ticked listings become the stops.
  const crmLead = useQuery({ queryKey: ['crm-lead', crmLeadId], queryFn: () => get<CrmLead>(`/crm/leads/${crmLeadId}`), enabled: Boolean(crmLeadId), retry: false, staleTime: Infinity });
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);

  // Default window: the next quarter hour at least 30 minutes away, for 2 hours.
  const [date, setDate] = useState(() => fmt.dateKey(new Date(roundUp(Date.now() + 30 * 60_000))));
  const [startTime, setStartTime] = useState(() => fmt.timeKey(new Date(roundUp(Date.now() + 30 * 60_000))));
  const [endTime, setEndTime] = useState(() => fmt.timeKey(new Date(roundUp(Date.now() + 150 * 60_000))));
  const [endTouched, setEndTouched] = useState(false);

  useEffect(() => {
    if (joinId) setStep((s) => (s === 'stops' && stops.length === 0 ? 'stops' : 'join'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinId]);

  useEffect(() => {
    if (!pinMode) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPinMode(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinMode]);

  const office = ref.data?.office;
  const reasons = ref.data?.reasons ?? [];
  const placed = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));

  useEffect(() => {
    const lead = crmLead.data;
    if (!lead || prefilledFor === lead.ref || reasons.length === 0) return;
    setPrefilledFor(lead.ref);
    setStops((s) => [
      ...s,
      ...lead.properties.map((p) => ({
        key: uid(),
        address: p.address,
        label: p.ref,
        lat: p.lat ?? NaN,
        lng: p.lng ?? NaN,
        placeId: null,
        propertyId: p.id,
        propertyLabel: `${p.ref} · ${p.address}`,
        reasonId: viewingReasonId(reasons, p.service),
        note: p.directions ?? '',
        crmLeadRef: lead.ref,
        crmLeadName: lead.firstName,
      })),
    ]);
    if (isAdmin && lead.agent?.userId && lead.agent.userId !== me.id) setOwnerId(lead.agent.userId);
    if (lead.properties.some((p) => p.lat == null)) toast.info('Some of these listings have no exact location yet. Tap the map to place each one for this trip, and pin them in the CRM so nobody is asked again.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crmLead.data, reasons]);
  const problems = stops.map((s) => stopProblem(s, reasons)).filter(Boolean);

  const preview = useQuery({
    queryKey: ['route', office?.id, placed.map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).join('|')],
    queryFn: () => post<RoutePreview>('/routes/preview', { origin: { lat: office!.lat, lng: office!.lng }, stops: placed.map((s) => ({ lat: s.lat, lng: s.lng })), returnToOrigin: true }),
    enabled: Boolean(office) && placed.length > 0,
    staleTime: 10 * 60_000,
  });

  // Suggest a return time from the drive plus ~30 minutes at each stop.
  useEffect(() => {
    if (endTouched || !preview.data) return;
    const start = new Date(fmt.toIso(date, startTime)).getTime();
    const needed = (preview.data.durationMin + 30 * Math.max(1, placed.length)) * 60_000;
    setEndTime(fmt.timeKey(new Date(roundUp(start + Math.max(needed, 60 * 60_000)))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.data, startTime, date]);

  const startIso = fmt.toIso(date, startTime);
  // A return time earlier than the start means the next day.
  const endIso = endTime > startTime ? fmt.toIso(date, endTime) : fmt.toIso(addDaysToDateKey(date, 1), endTime);

  const availability = useQuery({
    queryKey: ['availability', startIso, endIso],
    queryFn: () => get<Availability>(`/bookings/availability${qs({ start: startIso, end: endIso })}`),
    enabled: step === 'car',
  });

  useEffect(() => {
    const free = availability.data?.cars.filter((c) => c.available) ?? [];
    if (free.length && !free.some((c) => c.car.id === carId)) setCarId(free[0]!.car.id);
  }, [availability.data, carId]);

  const addPlace = async (p: PickedPlace) => {
    const stop: DraftStop = {
      key: uid(),
      address: p.address,
      label: p.label,
      lat: p.lat,
      lng: p.lng,
      placeId: p.placeId,
      propertyId: p.property?.id ?? null,
      propertyLabel: p.property ? `${p.property.ref} · ${p.property.client?.name ?? p.property.address}` : null,
      reasonId: '',
      note: '',
    };
    setStops((s) => [...s, stop]);
    if (!Number.isFinite(p.lat)) {
      setPinMode(true);
      toast.info(
        p.property?.crmRef?.startsWith(CRM_PROPERTY_PREFIX)
          ? "This listing has no exact location yet. Tap the map to place it for this trip, and pin it in the CRM (on the listing's location page) so you aren't asked again."
          : 'This property has no map location yet. Tap the map to place it.',
      );
    }
  };

  const onMapClick = async (pos: LatLng) => {
    const unplaced = stops.find((s) => !Number.isFinite(s.lat));
    if (unplaced) {
      setStops((s) => s.map((x) => (x.key === unplaced.key ? { ...x, lat: pos.lat, lng: pos.lng } : x)));
      setPinMode(false);
      return;
    }
    if (!pinMode) return;
    setPinMode(false);
    // Is this one of our properties?
    const near = await get<{ id: string; ref: string; address: string; meters: number }[]>(`/properties/nearby${qs({ lat: pos.lat, lng: pos.lng })}`).catch(() => []);
    const match = near[0] && near[0].meters < 60 ? near[0] : null;
    setStops((s) => [
      ...s,
      {
        key: uid(),
        address: match ? match.address : `Pin at ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`,
        label: match ? match.ref : 'Dropped pin',
        lat: pos.lat,
        lng: pos.lng,
        placeId: null,
        propertyId: match?.id ?? null,
        propertyLabel: match ? `${match.ref} · ${match.address}` : null,
        reasonId: '',
        note: '',
      },
    ]);
    if (match) toast.success(`Linked to ${match.ref}`);
  };

  const stopPayload = () =>
    stops.map((s) => ({ address: s.address, label: s.label, lat: s.lat, lng: s.lng, placeId: s.placeId, propertyId: s.propertyId, reasonId: s.reasonId, note: s.note || null, crmLeadRef: s.crmLeadRef ?? null, crmLeadName: s.crmLeadName ?? null }));

  const create = useMutation({
    mutationFn: () =>
      post<Booking>('/bookings', { carId, startAt: startIso, expectedReturnAt: endIso, stops: stopPayload(), notes: notes || null, urgent, ownerId: bookingFor?.id }),
    onSuccess: (b) => {
      toast.success(
        bookingFor
          ? `Booked and approved. ${shortName(bookingFor.name)} has been notified.`
          : urgent
            ? 'Urgent request sent. Every admin has been alerted by push and SMS.'
            : 'Request sent. The admins have been notified.',
      );
      void qc.invalidateQueries({ queryKey: ['bookings'] });
      void qc.invalidateQueries({ queryKey: ['current-trip'] });
      navigate(`/trips/${b.id}`);
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      if (err instanceof ApiError && err.status === 409) void availability.refetch();
    },
  });

  const joinBooking = joinTarget.data;
  const joinMut = useMutation({
    mutationFn: () => {
      const proposed = joinReturn && joinBooking ? fmt.toIso(fmt.dateKey(joinBooking.startAt), joinReturn) : undefined;
      return post(`/bookings/${joinId}/join-requests`, { stops: stopPayload(), proposedReturnAt: proposed, note: notes || null });
    },
    onSuccess: () => {
      toast.success(`Request sent. ${joinBooking ? shortName(joinBooking.owner.name) : 'The trip owner'} has been told and an admin will decide.`);
      void qc.invalidateQueries({ queryKey: ['bookings'] });
      navigate(`/trips/${joinId}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // ── Map ──────────────────────────────────────────────────────────────────────
  const markers = useMemo<MapMarker[]>(() => {
    const list: MapMarker[] = [];
    if (office) list.push({ id: 'office', position: office, kind: 'office', title: office.name });
    const existing = joinBooking?.stops.filter((s) => ['PLANNED', 'ARRIVED', 'DEPARTED'].includes(s.status)) ?? [];
    existing.forEach((s, i) => list.push({ id: `x-${s.id}`, position: s, kind: 'stop', label: String(i + 1), title: s.address }));
    placed.forEach((s) =>
      list.push({ id: s.key, position: s, kind: joinId ? 'proposed' : 'stop', label: String(existing.length + stops.indexOf(s) + 1), title: s.address }),
    );
    return list;
  }, [office, placed, stops, joinBooking, joinId]);

  const polylines = useMemo<MapPolyline[]>(() => {
    const lines: MapPolyline[] = [];
    if (joinBooking?.plannedPolyline) lines.push({ id: 'existing', path: decodePolyline(joinBooking.plannedPolyline), color: '#66706b', dashed: true, weight: 3 });
    if (preview.data && placed.length) lines.push({ id: 'route', path: decodePolyline(preview.data.polyline), dashed: preview.data.source === 'estimate' });
    return lines;
  }, [preview.data, placed.length, joinBooking]);

  const fitTo = useMemo(() => markers.map((m) => m.position), [markers]);

  if (ref.isLoading) return <PageLoader />;
  if (!office) return <EmptyState title="The office location isn't set up yet" description="An admin needs to add the office and its parking point in Office & settings." />;

  const canContinue = stops.length > 0 && problems.length === 0;
  const routeLine = preview.data && (
    <p className="flex items-center gap-1.5 text-xs text-muted-fg">
      <Route className="size-3.5" />
      Round trip ~{fmt.km(preview.data.distanceKm)} · {fmtDuration(preview.data.durationMin)} driving
      {preview.data.source === 'estimate' && ' (estimate)'}
    </p>
  );

  // ── Panel content per step ───────────────────────────────────────────────────
  let content: React.ReactNode;
  if (step === 'stops') {
    content = (
      <>
        {!joinId && <CurrentTripCard />}
        {!joinId && !crmLeadId && <InstallBanner />}
        {crmLeadId && <CrmLeadCard lead={crmLead.data} loading={crmLead.isLoading} error={crmLead.error} />}
        <h1 className="mb-3 text-xl font-semibold tracking-tight">{joinId ? 'Your stops' : 'Where to?'}</h1>
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-fg">
          <span className="size-2 rounded-full bg-fg" /> From {office.name}
        </div>
        <PlaceSearch onPick={addPlace} near={office} autoFocus={desktop} />
        <div className="mt-2 mb-4 flex items-center gap-2">
          <Button size="sm" variant={pinMode ? 'primary' : 'secondary'} onClick={() => setPinMode((v) => !v)}>
            <Crosshair /> {pinMode ? 'Tap the map…' : 'Drop a pin'}
          </Button>
          {routeLine}
        </div>
        <StopList stops={stops} reasons={reasons} onChange={setStops} tone={joinId ? 'warning' : 'primary'} />
      </>
    );
  } else if (step === 'when') {
    content = (
      <>
        <h1 className="mb-1 text-xl font-semibold tracking-tight">When?</h1>
        <p className="mb-4 text-sm text-muted-fg">Leave from and return to {office.name}. Times are East Africa Time.</p>
        <div className="grid gap-4">
          <Field label="Date">{(p) => <Input {...p} type="date" value={date} min={fmt.dateKey(new Date())} onChange={(e) => setDate(e.target.value)} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start">{(p) => <Input {...p} type="time" step={300} value={startTime} onChange={(e) => setStartTime(e.target.value)} />}</Field>
            <Field label="Back by" hint={endTime <= startTime ? 'Next day' : undefined}>
              {(p) => (
                <Input
                  {...p}
                  type="time"
                  step={900}
                  value={endTime}
                  onChange={(e) => {
                    setEndTouched(true);
                    setEndTime(e.target.value);
                  }}
                />
              )}
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-full border border-primary/40 bg-accent px-3 py-1 text-sm font-medium text-accent-fg"
              onClick={() => {
                const now = new Date(Math.ceil(Date.now() / 300_000) * 300_000);
                setDate(fmt.dateKey(now));
                setStartTime(fmt.timeKey(now));
                setEndTouched(false);
              }}
            >
              Leave now
            </button>
            {[1, 2, 3, 4].map((h) => (
              <button
                key={h}
                type="button"
                className="rounded-full border border-border px-3 py-1 text-sm hover:bg-muted"
                onClick={() => {
                  setEndTouched(true);
                  setEndTime(fmt.timeKey(new Date(new Date(startIso).getTime() + h * 3600_000)));
                }}
              >
                {h} h
              </button>
            ))}
          </div>
          {routeLine}
        </div>
      </>
    );
  } else if (step === 'car') {
    const a = availability.data;
    content = (
      <>
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Choose a car</h1>
        <p className="mb-4 text-sm text-muted-fg">{fmt.when(startIso, endIso)}</p>
        {availability.isLoading && <Spinner className="mx-auto my-8" />}
        {availability.error && <p className="text-sm text-danger">{errorMessage(availability.error)}</p>}
        {a && a.driver.noDriverConfigured && <p className="rounded-lg bg-danger-bg p-3 text-sm text-danger">No driver is set up yet. Ask an admin to add the driver.</p>}
        {a && !a.driver.available && !a.driver.noDriverConfigured && (
          <div className="grid gap-3">
            <div className="flex items-start gap-2 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>The driver is out at that time. Ask to add your stop to that trip, or pick another time.</span>
            </div>
            {a.driver.busyWith.map((s) => (
              <SlotCard
                key={s.bookingId}
                slot={s}
                onJoin={() => {
                  setParams({ join: s.bookingId });
                  setStep('join');
                }}
              />
            ))}
            <Button variant="secondary" onClick={() => setStep('when')}>
              <Clock /> Pick another time
            </Button>
          </div>
        )}
        {a && a.driver.available && (
          <div className="grid gap-2">
            <div className="mb-1 flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="size-4" /> The driver is free
            </div>
            {a.cars.map((c) => {
              const selected = carId === c.car.id;
              const why = c.reason === 'MAINTENANCE' ? 'In maintenance' : c.reason === 'BOOKED' ? c.blocking.map((b) => `${shortName(b.owner.name)} ${fmt.window(b.startAt, b.expectedReturnAt)}`).join(', ') : null;
              return (
                <button
                  key={c.car.id}
                  type="button"
                  disabled={!c.available}
                  onClick={() => setCarId(c.car.id)}
                  className={cn(
                    'flex items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55',
                    selected ? 'border-primary bg-accent ring-2 ring-primary/20' : 'border-border hover:bg-muted',
                  )}
                >
                  <div className={cn('grid size-10 shrink-0 place-items-center rounded-full', selected ? 'bg-primary text-primary-fg' : 'bg-muted text-muted-fg')}>
                    <CarIcon className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{c.car.registration}</p>
                    <p className="truncate text-xs text-muted-fg">
                      {c.car.make} {c.car.model}
                      {c.car.seats ? ` · ${c.car.seats} seats` : ''}
                      {c.car.color ? ` · ${c.car.color}` : ''}
                    </p>
                    {why && <p className="text-xs text-danger">{why}</p>}
                    {c.tentative.length > 0 && (
                      <p className="text-xs text-warning">Also requested (pending): {c.tentative.map((t) => `${shortName(t.owner.name)} ${fmt.window(t.startAt, t.expectedReturnAt)}`).join(', ')}</p>
                    )}
                  </div>
                </button>
              );
            })}
            {isAdmin && (
              <Field label="Book for" className="mt-3" hint={bookingFor ? `Approved straight away. ${shortName(bookingFor.name)} is notified and runs the trip.` : 'Book on a colleague\'s behalf, e.g. after a phone call.'}>
                {(p) => (
                  <Select {...p} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                    <option value="">Me</option>
                    {staff.data
                      ?.filter((u) => u.active && u.id !== me.id)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            )}
            <div className={cn('mt-3 rounded-xl border p-3', urgent ? 'border-danger/40 bg-danger-bg/60' : 'border-border')}>
              <Switch
                checked={urgent}
                onChange={setUrgent}
                label="Urgent"
                description={bookingFor ? `${shortName(bookingFor.name)} also gets an SMS.` : 'Every admin gets an alert by push and SMS/WhatsApp. Say why in the notes.'}
              />
            </div>
            <Field label={urgent ? 'What\'s the emergency?' : 'Notes for the admin (optional)'} className="mt-3">
              {(p) => <Textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}
            </Field>
            {routeLine}
          </div>
        )}
      </>
    );
  } else {
    // Join someone else's trip.
    const b = joinBooking;
    content = (
      <>
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Add your stop to a trip</h1>
        {joinTarget.isLoading && <Spinner className="mx-auto my-6" />}
        {b && (
          <div className="mt-3 grid gap-4">
            <div className="rounded-xl border border-border bg-surface-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-2 font-medium">
                  <UserRound className="size-4" /> {b.owner.name}
                </p>
                <BookingStatusBadge status={b.status} />
              </div>
              <p className="mt-1 text-sm text-muted-fg">
                {fmt.when(b.startAt, b.expectedReturnAt)} · {b.car.registration}
              </p>
              <p className="mt-1 text-sm">{b.stops.filter((s) => s.status !== 'PROPOSED' && s.status !== 'REJECTED').map((s) => s.label ?? s.address).join(' → ')}</p>
              <div className="mt-3">
                <ContactButtons phone={b.owner.phone} name={b.owner.name} />
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Your stops ({stops.length})</p>
              {stops.length === 0 ? (
                <Button variant="secondary" size="sm" onClick={() => setStep('stops')}>
                  <MapPin /> Add your stops
                </Button>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {stops.map((s, i) => (
                    <li key={s.key} className="flex items-center gap-2">
                      <Badge tone="warning">{(b.stops.filter((x) => x.status === 'PLANNED').length || 0) + i + 1}</Badge> {s.label ?? s.address}
                    </li>
                  ))}
                  <li>
                    <Button variant="link" size="sm" onClick={() => setStep('stops')}>
                      Edit stops
                    </Button>
                  </li>
                </ul>
              )}
            </div>
            <Field label="Need a later return? (optional)" hint={`Currently back by ${fmt.time(b.expectedReturnAt)}. The admin sees any clash before approving.`}>
              {(p) => <Input {...p} type="time" step={900} value={joinReturn} onChange={(e) => setJoinReturn(e.target.value)} />}
            </Field>
            <Field label="Message (optional)">{(p) => <Textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
            <p className="flex items-start gap-2 text-xs text-muted-fg">
              <Hand className="mt-0.5 size-3.5 shrink-0" /> {shortName(b.owner.name)} is told about your request. An admin approves or rejects it; their booking stays approved meanwhile.
            </p>
          </div>
        )}
      </>
    );
  }

  // ── Footer actions ───────────────────────────────────────────────────────────
  const back = () => {
    if (step === 'when') setStep('stops');
    else if (step === 'car') setStep('when');
    else if (step === 'join') {
      setParams({});
      setStep('car');
    } else if (step === 'stops' && joinId) setStep('join');
  };
  let primary: React.ReactNode;
  if (step === 'stops') {
    primary = (
      <Button size="lg" className="flex-1" disabled={!canContinue} onClick={() => setStep(joinId ? 'join' : 'when')}>
        {stops.length === 0 ? 'Add a stop to continue' : problems.length ? problems[0] : 'Next: when?'}
      </Button>
    );
  } else if (step === 'when') {
    primary = (
      <Button size="lg" className="flex-1" onClick={() => setStep('car')} disabled={new Date(startIso).getTime() < Date.now() - 5 * 60_000}>
        Check availability
      </Button>
    );
  } else if (step === 'car') {
    primary = (
      <Button
        size="lg"
        variant={urgent && !bookingFor ? 'danger' : 'primary'}
        className="flex-1"
        loading={create.isPending}
        disabled={!availability.data?.bookable || !carId}
        onClick={() => create.mutate()}
      >
        {bookingFor ? 'Book & approve' : urgent ? 'Send urgent request' : 'Request trip'}
      </Button>
    );
  } else {
    primary = (
      <Button size="lg" className="flex-1" loading={joinMut.isPending} disabled={!joinBooking || stops.length === 0 || problems.length > 0} onClick={() => joinMut.mutate()}>
        Send request
      </Button>
    );
  }
  const showBack = step !== 'stops' || Boolean(joinId);

  return (
    <div className="relative flex h-full min-h-[480px] flex-col">
      {/* On phones the map ends where the sheet starts, so the map credits (and Google's logo, which must stay visible) aren't covered. */}
      <div className={cn('relative min-h-0 flex-1 lg:absolute lg:inset-0', pinMode && 'cursor-crosshair')}>
        <MapView
          center={office}
          zoom={13}
          markers={markers}
          polylines={polylines}
          fitTo={fitTo}
          fitPadding={desktop ? { top: 60, right: 60, bottom: 60, left: 480 } : { top: 40, right: 30, bottom: 30, left: 30 }}
          onClick={onMapClick}
        />
      </div>
      {pinMode && (
        <div className="pointer-events-none absolute top-4 left-1/2 z-[500] -translate-x-1/2 rounded-full bg-fg px-4 py-2 text-sm font-medium text-bg shadow-float lg:left-[calc(50%+220px)]">
          Tap the map to drop a pin
        </div>
      )}
      <section
        className={cn(
          'relative z-[400] flex shrink-0 flex-col bg-surface shadow-float',
          'max-h-[62%] rounded-t-3xl',
          'lg:absolute lg:top-4 lg:bottom-4 lg:left-4 lg:max-h-none lg:w-[440px] lg:rounded-3xl',
        )}
      >
        <div className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-border lg:hidden" />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4 lg:px-5 lg:pt-5">{content}</div>
        <div className="safe-bottom flex gap-2 border-t border-border px-4 py-3 lg:px-5">
          {showBack && (
            <Button size="lg" variant="secondary" onClick={back} aria-label="Back">
              <ArrowLeft />
            </Button>
          )}
          {primary}
        </div>
      </section>
    </div>
  );
}

