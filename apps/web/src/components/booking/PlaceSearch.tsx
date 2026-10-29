import { useQuery } from '@tanstack/react-query';
import { Building2, MapPin, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, qs } from '@/lib/api';
import type { Property } from '@/lib/types';
import { cn } from '@/lib/utils';
import { usingGoogleMaps } from '../map/MapView';
import { Spinner } from '../ui/misc';

export interface PickedPlace {
  address: string;
  label: string | null;
  lat: number;
  lng: number;
  placeId: string | null;
  property: Property | null;
}

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface PlaceSuggestion {
  id: string;
  main: string;
  secondary: string;
  prediction: google.maps.places.PlacePrediction;
}

/**
 * Places autocomplete (New) with a session token per search, biased to Kenya.
 * Only used when Google Maps is configured and loaded.
 */
function useGooglePlaces(input: string, near: { lat: number; lng: number } | null) {
  const session = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const [items, setItems] = useState<PlaceSuggestion[]>([]);
  useEffect(() => {
    if (!usingGoogleMaps || input.trim().length < 3 || typeof google === 'undefined' || !google.maps?.importLibrary) {
      setItems([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const places = (await google.maps.importLibrary('places')) as google.maps.PlacesLibrary;
      session.current ??= new places.AutocompleteSessionToken();
      const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input,
        sessionToken: session.current,
        includedRegionCodes: ['ke'],
        ...(near ? { locationBias: { center: near, radius: 30_000 } } : {}),
      });
      if (cancelled) return;
      setItems(
        suggestions
          .map((s) => s.placePrediction)
          .filter((p): p is google.maps.places.PlacePrediction => Boolean(p))
          .slice(0, 5)
          .map((p) => ({ id: p.placeId, main: p.mainText?.text ?? p.text.text, secondary: p.secondaryText?.text ?? '', prediction: p })),
      );
    })().catch(() => setItems([]));
    return () => {
      cancelled = true;
    };
  }, [input, near]);

  const resolve = async (s: PlaceSuggestion): Promise<PickedPlace | null> => {
    const place = s.prediction.toPlace();
    await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
    session.current = null; // a session ends when a place is picked
    if (!place.location) return null;
    return {
      address: place.formattedAddress?.replace(/, Kenya$/, '') ?? s.main,
      label: place.displayName ?? s.main,
      lat: place.location.lat(),
      lng: place.location.lng(),
      placeId: s.id,
      property: null,
    };
  };
  return { items, resolve };
}

/**
 * "Where to?": search our property list (reference, address, client) and,
 * when Google Maps is configured, any place in Kenya.
 */
export function PlaceSearch({
  onPick,
  near,
  propertiesOnly,
  placeholder = 'Search a property, address or client',
  autoFocus,
}: {
  onPick: (p: PickedPlace) => void;
  near?: { lat: number; lng: number } | null;
  propertiesOnly?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const q = useDebounced(text.trim());
  const properties = useQuery({
    queryKey: ['properties', 'search', q],
    queryFn: () => get<Property[]>(`/properties${qs({ q, limit: 8 })}`),
    enabled: q.length >= 2,
  });
  const google = useGooglePlaces(propertiesOnly ? '' : q, near ?? null);
  const results = useMemo(() => properties.data ?? [], [properties.data]);

  const pick = (p: PickedPlace) => {
    onPick(p);
    setText('');
    setOpen(false);
  };

  const showList = open && q.length >= 2;
  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted-fg" />
        <input
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          placeholder={placeholder}
          className="h-12 w-full rounded-xl border border-border bg-surface-2 pr-10 pl-11 text-[15px] placeholder:text-muted-fg/80 focus:border-primary focus:bg-surface focus:ring-2 focus:ring-primary/20 focus:outline-none"
          aria-label={placeholder}
          aria-expanded={showList}
          role="combobox"
        />
        {properties.isFetching && <Spinner className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />}
      </div>
      {showList && (
        // Keep focus in the input while picking so the blur above doesn't close the list first.
        <div
          role="listbox"
          onMouseDown={(e) => e.preventDefault()}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-float"
        >
          {results.map((p) => (
            <button
              key={p.id}
              role="option"
              aria-selected={false}
              type="button"
              className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted"
              onClick={() =>
                pick({ address: p.address, label: p.ref, lat: p.lat ?? NaN, lng: p.lng ?? NaN, placeId: null, property: p })
              }
            >
              <Building2 className="mt-0.5 size-4 shrink-0 text-primary" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {p.ref} · {p.address}
                </span>
                <span className="block truncate text-xs text-muted-fg">
                  {p.client?.name ?? 'No client'} · {p.service.toLowerCase()}
                  {p.status !== 'ACTIVE' && ` · ${p.status.toLowerCase()}`}
                  {p.lat == null && ' · no map location yet'}
                </span>
              </span>
            </button>
          ))}
          {google.items.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={false}
              className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted"
              onClick={async () => {
                const r = await google.resolve(s);
                if (r) pick(r);
              }}
            >
              <MapPin className="mt-0.5 size-4 shrink-0 text-muted-fg" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{s.main}</span>
                <span className="block truncate text-xs text-muted-fg">{s.secondary}</span>
              </span>
            </button>
          ))}
          {!properties.isFetching && results.length === 0 && google.items.length === 0 && (
            <p className={cn('px-3 py-3 text-sm text-muted-fg')}>
              No matches. {propertiesOnly ? 'Add it as a new property below.' : 'Try another search, or drop a pin on the map.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
