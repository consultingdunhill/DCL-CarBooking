import { ArrowDown, ArrowUp, Building2, MapPin, Plus, StickyNote, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { Property, VisitReason } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/form';
import { PlaceSearch } from './PlaceSearch';
import { PropertyQuickAdd } from './PropertyQuickAdd';
import { ReasonSelect } from './ReasonSelect';

export interface DraftStop {
  key: string;
  address: string;
  label: string | null;
  lat: number;
  lng: number;
  placeId: string | null;
  propertyId: string | null;
  propertyLabel: string | null;
  reasonId: string;
  note: string;
  crmLeadRef?: string | null;
  crmLeadName?: string | null;
}

export function stopProblem(s: DraftStop, reasons: VisitReason[]): string | null {
  if (!s.reasonId) return 'Choose a reason';
  const reason = reasons.find((r) => r.id === s.reasonId);
  if (reason?.needsProperty && !s.propertyId) return `${reason.label} must be linked to a property`;
  if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return 'Place this stop on the map';
  return null;
}

function linkProperty(s: DraftStop, p: Property): DraftStop {
  return {
    ...s,
    propertyId: p.id,
    propertyLabel: `${p.ref} · ${p.client?.name ?? p.address}`,
    label: s.label ?? p.ref,
    // Use the property's own location when it has one.
    ...(p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng, address: p.address } : {}),
  };
}

function StopCard({
  stop,
  index,
  count,
  reasons,
  onChange,
  onRemove,
  onMove,
  tone,
}: {
  stop: DraftStop;
  index: number;
  count: number;
  reasons: VisitReason[];
  onChange: (s: DraftStop) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  tone: 'primary' | 'warning';
}) {
  const reason = reasons.find((r) => r.id === stop.reasonId);
  const [noteOpen, setNoteOpen] = useState(Boolean(stop.note));
  const [adding, setAdding] = useState(false);
  const problem = stopProblem(stop, reasons);
  const missingPlace = !Number.isFinite(stop.lat);

  return (
    <li className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold text-white', tone === 'warning' ? 'bg-warning' : 'bg-primary')}>{index + 1}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{stop.label ?? stop.address}</p>
          {stop.label && <p className="truncate text-xs text-muted-fg">{stop.address}</p>}
          {stop.crmLeadName && <p className="truncate text-xs font-medium text-info">For {stop.crmLeadName}, from the CRM</p>}
          {missingPlace && <p className="mt-1 text-xs font-medium text-warning">Tap the map to place this stop</p>}
        </div>
        <div className="flex shrink-0 items-center">
          <Button size="icon-sm" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">
            <ArrowUp />
          </Button>
          <Button size="icon-sm" variant="ghost" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move down">
            <ArrowDown />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={onRemove} aria-label="Remove stop">
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2 pl-10">
        <ReasonSelect reasons={reasons} value={stop.reasonId} onChange={(reasonId) => onChange({ ...stop, reasonId })} invalid={!stop.reasonId} />

        {stop.propertyId ? (
          <div className="flex items-center gap-2 rounded-lg bg-accent px-2.5 py-1.5 text-sm text-accent-fg">
            <Building2 className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{stop.propertyLabel}</span>
            <button type="button" onClick={() => onChange({ ...stop, propertyId: null, propertyLabel: null })} aria-label="Unlink property" className="rounded p-0.5 hover:bg-black/5">
              <X className="size-4" />
            </button>
          </div>
        ) : reason?.needsProperty ? (
          <div className="grid gap-2 rounded-lg border border-dashed border-warning/50 bg-warning-bg/50 p-2">
            <p className="text-xs font-medium text-warning">{reason.label} must be linked to a property</p>
            <PlaceSearch propertiesOnly placeholder="Find the property" onPick={(p) => p.property && onChange(linkProperty(stop, p.property))} />
            <Button size="sm" variant="link" className="justify-start" onClick={() => setAdding(true)}>
              <Plus /> Not in the list? Add a new property
            </Button>
          </div>
        ) : null}

        {noteOpen ? (
          <Input placeholder="Note (optional), e.g. who you're meeting" value={stop.note} onChange={(e) => onChange({ ...stop, note: e.target.value })} />
        ) : (
          <button type="button" className="flex items-center gap-1.5 justify-self-start text-xs font-medium text-muted-fg hover:text-fg" onClick={() => setNoteOpen(true)}>
            <StickyNote className="size-3.5" /> Add a note
          </button>
        )}
        {problem && !missingPlace && stop.reasonId && <p className="text-xs text-danger">{problem}</p>}
      </div>

      <PropertyQuickAdd
        open={adding}
        onOpenChange={setAdding}
        initial={{ address: stop.address, lat: Number.isFinite(stop.lat) ? stop.lat : null, lng: Number.isFinite(stop.lng) ? stop.lng : null }}
        onCreated={(p) => onChange(linkProperty(stop, p))}
      />
    </li>
  );
}

export function StopList({ stops, reasons, onChange, tone = 'primary' }: { stops: DraftStop[]; reasons: VisitReason[]; onChange: (s: DraftStop[]) => void; tone?: 'primary' | 'warning' }) {
  if (stops.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-fg">
        <MapPin className="size-5 shrink-0" />
        Search above, or use Drop a pin to choose a place on the map. Add as many stops as you need.
      </div>
    );
  }
  const move = (i: number, dir: -1 | 1) => {
    const next = [...stops];
    [next[i], next[i + dir]] = [next[i + dir]!, next[i]!];
    onChange(next);
  };
  return (
    <ol className="grid grid-cols-[minmax(0,1fr)] gap-2">
      {stops.map((s, i) => (
        <StopCard
          key={s.key}
          stop={s}
          index={i}
          count={stops.length}
          reasons={reasons}
          tone={tone}
          onChange={(n) => onChange(stops.map((x) => (x.key === s.key ? n : x)))}
          onRemove={() => onChange(stops.filter((x) => x.key !== s.key))}
          onMove={(d) => move(i, d)}
        />
      ))}
    </ol>
  );
}
