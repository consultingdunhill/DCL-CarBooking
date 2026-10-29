import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/form';
import { Spinner } from '@/components/ui/misc';
import { get, qs } from '@/lib/api';
import type { Property } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useDebounced } from './hooks';

export interface PickedProperty {
  id: string;
  label: string;
}

/** Search-as-you-type property filter (GET /properties?q=). */
export function PropertyPicker({ value, onChange, id, className }: { value: PickedProperty | null; onChange: (p: PickedProperty | null) => void; id?: string; className?: string }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebounced(text.trim(), 250);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useQuery({
    queryKey: ['properties', 'search', q],
    queryFn: () => get<Property[]>(`/properties${qs({ q, limit: 20 })}`),
    enabled: open && q.length > 0,
    staleTime: 60_000,
  });
  const items = q ? (results.data ?? []) : [];

  if (value) {
    return (
      <div className={cn('flex h-10 items-center gap-2 rounded-lg border border-border bg-surface pr-1 pl-3 text-sm', className)}>
        <span className="min-w-0 flex-1 truncate" title={value.label}>
          {value.label}
        </span>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-fg hover:bg-muted hover:text-fg"
          onClick={() => {
            onChange(null);
            setText('');
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          aria-label="Clear property filter"
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  const pick = (p: Property) => {
    onChange({ id: p.id, label: `${p.ref} · ${p.address}` });
    setOpen(false);
    setText('');
  };

  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-fg" />
      <Input
        ref={inputRef}
        id={id}
        value={text}
        placeholder="Search ref or address"
        className="pl-9"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(items.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter' && items[active]) {
            e.preventDefault();
            pick(items[active]);
          } else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && q.length > 0 && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-float" id={listId} role="listbox">
          {results.isLoading ? (
            <div className="flex justify-center py-3">
              <Spinner className="size-4" />
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-fg">No matching properties</div>
          ) : (
            items.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
                className={cn('flex w-full flex-col items-start px-3 py-2 text-left text-sm', i === active ? 'bg-muted' : 'hover:bg-muted')}
              >
                <span className="font-medium">{p.ref}</span>
                <span className="w-full truncate text-xs text-muted-fg">
                  {p.address}
                  {p.client ? ` · ${p.client.name}` : ''}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
