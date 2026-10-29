import type { LatLng } from '@carbooking/core';
import { useQueryClient } from '@tanstack/react-query';
import { LocateFixed } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, get, post, put, qs } from '@/lib/api';
import { useReference } from '@/lib/queries';
import { useTrackerState } from '@/lib/tracking';
import type { Stop } from '@/lib/types';
import { uid } from '@/lib/utils';
import { MapView, type MapMarker } from '../map/MapView';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { PlaceSearch, type PickedPlace } from './PlaceSearch';
import { StopList, stopProblem, type DraftStop } from './StopList';

function fromStop(s: Stop): DraftStop {
  return {
    key: s.id,
    address: s.address,
    label: s.label,
    lat: s.lat,
    lng: s.lng,
    placeId: null,
    propertyId: s.property?.id ?? null,
    propertyLabel: s.property ? `${s.property.ref} · ${s.property.client?.name ?? s.property.address}` : null,
    reasonId: s.reasonId,
    note: s.note ?? '',
  };
}

const blank = (p: LatLng & { address: string; label: string | null; placeId?: string | null }): DraftStop => ({
  key: uid(),
  address: p.address,
  label: p.label,
  lat: p.lat,
  lng: p.lng,
  placeId: p.placeId ?? null,
  propertyId: null,
  propertyLabel: null,
  reasonId: '',
  note: '',
});

/**
 * Add a stop to a running trip, or change an upcoming one: search, use the
 * phone's current position (emergencies), or tap the map.
 */
export function TripStopDialog({
  tripId,
  bookingId,
  stop,
  open,
  onOpenChange,
}: {
  tripId: string;
  bookingId: string;
  /** The stop to change; omit to add a new one. */
  stop?: Stop;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const ref = useReference();
  const qc = useQueryClient();
  const tracker = useTrackerState();
  const [draft, setDraft] = useState<DraftStop | null>(stop ? fromStop(stop) : null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setDraft(stop ? fromStop(stop) : null);
  }, [open, stop]);

  const reasons = ref.data?.reasons ?? [];
  const office = ref.data?.office;
  const center = draft ?? tracker.lastFix ?? office ?? { lat: -1.2864, lng: 36.8172 };

  const place = (p: PickedPlace) => {
    const next = blank(p);
    if (p.property) {
      next.propertyId = p.property.id;
      next.propertyLabel = `${p.property.ref} · ${p.property.client?.name ?? p.property.address}`;
    }
    setDraft((d) => (d ? { ...next, key: d.key, reasonId: d.reasonId, note: d.note } : next));
  };

  const pin = async (pos: LatLng, label: string) => {
    const near = await get<{ id: string; ref: string; address: string; meters: number }[]>(`/properties/nearby${qs({ lat: pos.lat, lng: pos.lng })}`).catch(() => []);
    const match = near[0] && near[0].meters < 60 ? near[0] : null;
    setDraft((d) => ({
      ...(d ?? blank({ ...pos, address: '', label: null })),
      lat: pos.lat,
      lng: pos.lng,
      address: match ? match.address : `${label} (${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)})`,
      label: match ? match.ref : label,
      placeId: null,
      ...(match ? { propertyId: match.id, propertyLabel: `${match.ref} · ${match.address}` } : {}),
    }));
  };

  const useMyLocation = async () => {
    if (tracker.lastFix) return pin(tracker.lastFix, 'Current location');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        void pin({ lat: p.coords.latitude, lng: p.coords.longitude }, 'Current location');
      },
      () => {
        setLocating(false);
        toast.error("Couldn't get your location. Tap the map instead.");
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const markers = useMemo<MapMarker[]>(() => {
    const list: MapMarker[] = [];
    if (office) list.push({ id: 'office', position: office, kind: 'office' });
    if (tracker.lastFix) list.push({ id: 'me', position: tracker.lastFix, kind: 'dot', color: '#1f4fbf', title: 'You' });
    if (draft && Number.isFinite(draft.lat)) list.push({ id: 'stop', position: draft, kind: 'pin', title: draft.address });
    return list;
  }, [office, tracker.lastFix, draft]);

  const problem = draft ? stopProblem(draft, reasons) : 'Choose a place';
  const submit = async () => {
    if (!draft || problem) return;
    setBusy(true);
    const body = { address: draft.address, label: draft.label, lat: draft.lat, lng: draft.lng, placeId: draft.placeId, propertyId: draft.propertyId, reasonId: draft.reasonId, note: draft.note || null };
    try {
      if (stop) await put(`/trips/${tripId}/stops/${stop.id}`, body);
      else await post(`/trips/${tripId}/stops`, body);
      toast.success(stop ? 'Stop changed. The admins have been told.' : 'Stop added. The admins have been told.');
      void qc.invalidateQueries({ queryKey: ['booking', bookingId] });
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={stop ? 'Change stop' : 'Add a stop'}
      description="The route and ETA are recalculated and the admins are told."
      size="lg"
      footer={
        <Button loading={busy} disabled={Boolean(problem)} onClick={submit}>
          {problem && draft ? problem : stop ? 'Save change' : 'Add stop'}
        </Button>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <PlaceSearch onPick={place} near={tracker.lastFix ?? office} />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" loading={locating} onClick={useMyLocation}>
            <LocateFixed /> Use my current location
          </Button>
          <span className="text-xs text-muted-fg">or tap the map</span>
        </div>
        <div className="h-48 overflow-hidden rounded-xl border border-border">
          <MapView center={center} zoom={14} markers={markers} fitTo={draft && Number.isFinite(draft.lat) ? [draft] : undefined} onClick={(p) => void pin(p, 'Dropped pin')} />
        </div>
        {draft && <StopList stops={[draft]} reasons={reasons} onChange={(list) => setDraft(list[0] ?? null)} />}
      </div>
    </Dialog>
  );
}
