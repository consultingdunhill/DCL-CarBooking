import { decodePolyline, DEPARTMENT_LABELS, shortName } from '@carbooking/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ClipboardCheck, Users, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ContactButtons } from '@/components/ContactButtons';
import { MapView, type MapMarker } from '@/components/map/MapView';
import { Page } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/form';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { errorMessage, get, post, qs } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useReference } from '@/lib/queries';
import type { Approvals, Conflicts, Slot } from '@/lib/types';

type PendingBooking = Approvals['bookings'][number];
type PendingJoin = Approvals['joinRequests'][number];

function ConflictList({ conflicts }: { conflicts: Conflicts | null }) {
  const fmt = useFormat();
  if (!conflicts) return null;
  const hard = [...conflicts.car, ...conflicts.driver].filter((s, i, a) => a.findIndex((x) => x.bookingId === s.bookingId) === i);
  const line = (s: Slot) => `${shortName(s.owner.name)} · ${s.car.registration} · ${fmt.window(s.startAt, s.expectedReturnAt)}`;
  if (hard.length === 0 && conflicts.pendingOverlaps.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-success">
        <Check className="size-3.5" /> No clashes
      </p>
    );
  }
  return (
    <div className="grid gap-1 text-xs">
      {hard.map((s) => (
        <p key={s.bookingId} className="flex items-start gap-1.5 text-danger">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Clashes with approved trip: {line(s)}
        </p>
      ))}
      {conflicts.pendingOverlaps.map((s) => (
        <p key={s.bookingId} className="flex items-start gap-1.5 text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Also requested (pending): {line(s)}
        </p>
      ))}
    </div>
  );
}

function MiniMap({ stops, polyline, proposed }: { stops: { id: string; lat: number; lng: number; address: string }[]; polyline: string | null; proposed?: { id: string; lat: number; lng: number; address: string }[] }) {
  const ref = useReference();
  const office = ref.data?.office;
  const markers = useMemo<MapMarker[]>(() => {
    const list: MapMarker[] = [];
    if (office) list.push({ id: 'office', position: office, kind: 'office' });
    stops.forEach((s, i) => list.push({ id: s.id, position: s, kind: 'stop', label: String(i + 1), title: s.address }));
    proposed?.forEach((s, i) => list.push({ id: s.id, position: s, kind: 'proposed', label: String(stops.length + i + 1), title: s.address }));
    return list;
  }, [office, stops, proposed]);
  const polylines = useMemo(() => (polyline ? [{ id: 'r', path: decodePolyline(polyline), dashed: true }] : []), [polyline]);
  if (!office) return null;
  return (
    <div className="h-44 overflow-hidden rounded-xl border border-border lg:h-full lg:min-h-48">
      <MapView center={office} markers={markers} polylines={polylines} fitTo={markers.map((m) => m.position)} />
    </div>
  );
}

function RejectDialog({ open, onOpenChange, onReject, busy }: { open: boolean; onOpenChange: (o: boolean) => void; onReject: (reason: string) => void; busy: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reject request"
      description="The requester sees this reason."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => onReject(reason.trim())}>
            Reject
          </Button>
        </>
      }
    >
      <Field label="Reason" required>
        {(p) => <Textarea {...p} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Car needed for a management inspection" autoFocus />}
      </Field>
    </Dialog>
  );
}

function BookingRequest({ b }: { b: PendingBooking }) {
  const fmt = useFormat();
  const ref = useReference();
  const qc = useQueryClient();
  const [carId, setCarId] = useState(b.carId);
  const [driverId, setDriverId] = useState(b.driverId);
  const [rejecting, setRejecting] = useState(false);
  const reassigned = carId !== b.carId || driverId !== b.driverId;
  const preview = useQuery({
    queryKey: ['conflicts', b.id, carId, driverId],
    queryFn: () => get<Conflicts>(`/bookings/${b.id}/conflicts${qs({ carId, driverId })}`),
    enabled: reassigned,
  });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['approvals'] });
    void qc.invalidateQueries({ queryKey: ['bookings'] });
  };
  const approve = useMutation({
    mutationFn: () => post(`/bookings/${b.id}/approve`, reassigned ? { carId, driverId } : {}),
    onSuccess: () => {
      toast.success(`Approved ${shortName(b.owner.name)}'s trip`);
      done();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      done();
    },
  });
  const reject = useMutation({
    mutationFn: (reason: string) => post(`/bookings/${b.id}/reject`, { reason }),
    onSuccess: () => {
      toast.success('Rejected');
      setRejecting(false);
      done();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const stops = b.stops.filter((s) => s.status === 'PLANNED');
  const conflicts = reassigned ? (preview.data ?? null) : b.conflicts;
  const hardClash = conflicts ? conflicts.car.length + conflicts.driver.length > 0 : false;

  return (
    <Card className={b.urgent ? 'overflow-hidden border-danger/50 ring-2 ring-danger/15' : 'overflow-hidden'}>
      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_280px]">
        <div className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="flex items-center gap-2 font-semibold">
                {b.owner.name} {b.urgent && <Badge tone="danger">Urgent</Badge>}
              </p>
              <p className="text-sm text-muted-fg">
                {fmt.when(b.startAt, b.expectedReturnAt)} · requested {fmt.relative(b.createdAt)}
              </p>
            </div>
            <ContactButtons phone={b.owner.phone} name={b.owner.name} />
          </div>
          <ol className="grid gap-1.5">
            {stops.map((s, i) => (
              <li key={s.id} className="flex gap-2 text-sm">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-fg">{i + 1}</span>
                <span className="min-w-0">
                  <span className="font-medium">{s.property ? `${s.property.ref} · ${s.property.address}` : (s.label ?? s.address)}</span>
                  <span className="block text-xs text-muted-fg">
                    {s.reason.label} ({DEPARTMENT_LABELS[s.reason.department]}){s.property?.client && ` · ${s.property.client.name}`}
                    {s.note && ` · "${s.note}"`}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          {b.notes && <p className="rounded-lg bg-muted px-3 py-2 text-sm">{b.notes}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Car">
              {(p) => (
                <Select {...p} value={carId} onChange={(e) => setCarId(e.target.value)}>
                  {ref.data?.cars.map((c) => (
                    <option key={c.id} value={c.id} disabled={c.status !== 'AVAILABLE'}>
                      {c.registration} · {c.make} {c.model}
                      {c.status !== 'AVAILABLE' ? ' (maintenance)' : ''}
                      {c.id === b.carId ? ' — requested' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Driver">
              {(p) => (
                <Select {...p} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                  {ref.data?.drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <ConflictList conflicts={conflicts} />
          <div className="flex flex-wrap gap-2">
            <Button loading={approve.isPending} disabled={hardClash} onClick={() => approve.mutate()}>
              <Check /> {reassigned ? 'Reassign & approve' : 'Approve'}
            </Button>
            <Button variant="danger-outline" onClick={() => setRejecting(true)}>
              <X /> Reject
            </Button>
            <Button variant="ghost" asChild>
              <Link to={`/trips/${b.id}`}>Details</Link>
            </Button>
          </div>
        </div>
        <MiniMap stops={stops} polyline={b.plannedPolyline} />
      </div>
      <RejectDialog open={rejecting} onOpenChange={setRejecting} busy={reject.isPending} onReject={(r) => reject.mutate(r)} />
    </Card>
  );
}

function JoinRequestCard({ j }: { j: PendingJoin }) {
  const fmt = useFormat();
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['approvals'] });
    void qc.invalidateQueries({ queryKey: ['bookings'] });
  };
  const approve = useMutation({
    mutationFn: () => post(`/join-requests/${j.id}/approve`),
    onSuccess: () => {
      toast.success(`${shortName(j.requester.name)} added to the trip`);
      done();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const reject = useMutation({
    mutationFn: (reason: string) => post(`/join-requests/${j.id}/reject`, { reason }),
    onSuccess: () => {
      toast.success('Rejected');
      setRejecting(false);
      done();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const existing = j.booking.stops.filter((s) => ['PLANNED', 'ARRIVED', 'DEPARTED'].includes(s.status));
  const hardClash = j.clash ? j.clash.car.length + j.clash.driver.length > 0 : false;

  return (
    <Card className="overflow-hidden border-warning/30">
      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_280px]">
        <div className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="flex items-center gap-2 font-semibold">
                <Users className="size-4" /> {j.requester.name} wants to join {shortName(j.booking.owner.name)}'s trip
              </p>
              <p className="text-sm text-muted-fg">
                {fmt.when(j.booking.startAt, j.booking.expectedReturnAt)} · {j.booking.car.registration} · <Badge tone={j.booking.status === 'PENDING' ? 'warning' : 'primary'}>{j.booking.status === 'PENDING' ? 'trip pending' : 'trip approved'}</Badge>
              </p>
            </div>
            <ContactButtons phone={j.requester.phone} name={j.requester.name} />
          </div>
          <div className="text-sm">
            <p className="mb-1 text-xs font-medium tracking-wide text-muted-fg uppercase">Stops to add</p>
            <ol className="grid gap-1">
              {j.stops.map((s, i) => (
                <li key={s.id} className="flex gap-2">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-warning text-[11px] font-semibold text-white">{existing.length + i + 1}</span>
                  <span>
                    {s.property ? `${s.property.ref} · ${s.property.address}` : (s.label ?? s.address)}
                    <span className="block text-xs text-muted-fg">{s.reason.label}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          {j.proposedReturnAt && (
            <p className="text-sm">
              Return moves from <strong>{fmt.time(j.booking.expectedReturnAt)}</strong> to <strong>{fmt.time(j.proposedReturnAt)}</strong>
            </p>
          )}
          {j.note && <p className="rounded-lg bg-muted px-3 py-2 text-sm">{j.note}</p>}
          <ConflictList conflicts={j.clash} />
          <div className="flex flex-wrap gap-2">
            <Button loading={approve.isPending} disabled={hardClash} onClick={() => approve.mutate()}>
              <Check /> Approve
            </Button>
            <Button variant="danger-outline" onClick={() => setRejecting(true)}>
              <X /> Reject
            </Button>
          </div>
        </div>
        <MiniMap stops={existing} proposed={j.stops} polyline={j.booking.plannedPolyline} />
      </div>
      <RejectDialog open={rejecting} onOpenChange={setRejecting} busy={reject.isPending} onReject={(r) => reject.mutate(r)} />
    </Card>
  );
}

export function ApprovalsPage() {
  const q = useQuery({ queryKey: ['approvals'], queryFn: () => get<Approvals>('/approvals'), refetchInterval: 60_000 });
  const count = (q.data?.bookings.length ?? 0) + (q.data?.joinRequests.length ?? 0);
  return (
    <Page wide>
      <PageHeader title="Approvals" description="Every admin sees every request. The first decision wins; a clash with an approved trip can't be approved." />
      {q.isLoading ? (
        <div className="grid gap-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : count === 0 ? (
        <EmptyState icon={<ClipboardCheck />} title="All caught up" description="New trip requests and requests to join a trip appear here." />
      ) : (
        <div className="grid gap-6">
          {q.data!.joinRequests.length > 0 && (
            <section className="grid gap-3">
              <h2 className="text-sm font-semibold tracking-wide text-muted-fg uppercase">Requests to join a trip ({q.data!.joinRequests.length})</h2>
              {q.data!.joinRequests.map((j) => (
                <JoinRequestCard key={j.id} j={j} />
              ))}
            </section>
          )}
          {q.data!.bookings.length > 0 && (
            <section className="grid gap-3">
              <h2 className="text-sm font-semibold tracking-wide text-muted-fg uppercase">Trip requests ({q.data!.bookings.length})</h2>
              {q.data!.bookings.map((b) => (
                <BookingRequest key={b.id} b={b} />
              ))}
            </section>
          )}
        </div>
      )}
    </Page>
  );
}
