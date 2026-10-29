import type { UseQueryResult } from '@tanstack/react-query';
import { AlertTriangle, Info, Search, X } from 'lucide-react';
import { forwardRef, useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { cn } from '@/lib/utils';

/** Debounce a fast-changing value (search boxes). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function TableSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2 p-4', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/** Loading → skeleton, error → retry, empty → empty state, otherwise render the data. */
export function QueryBlock<T>({
  query,
  children,
  skeleton,
  empty,
  isEmpty,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  skeleton?: ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
}) {
  if (query.isPending) return <>{skeleton ?? <TableSkeleton />}</>;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  const blank = isEmpty ? isEmpty(data) : Array.isArray(data) && data.length === 0;
  if (empty && blank) return <>{empty}</>;
  return <>{children(data)}</>;
}

export function SearchInput({ value, onChange, placeholder = 'Search', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cn('relative w-full sm:w-72', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-fg" />
      <Input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden" />
      {value && (
        <button type="button" onClick={() => onChange('')} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-fg hover:text-fg" aria-label="Clear search">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

/** A short note in a tinted box. */
export function Callout({ tone = 'info', title, children, className, icon }: { tone?: 'info' | 'warning' | 'neutral'; title?: ReactNode; children?: ReactNode; className?: string; icon?: ReactNode }) {
  const styles = {
    info: 'bg-info-bg text-info',
    warning: 'bg-warning-bg text-warning',
    neutral: 'bg-muted text-muted-fg',
  }[tone];
  return (
    <div className={cn('flex gap-3 rounded-xl px-4 py-3 text-sm', styles, className)}>
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon ?? (tone === 'warning' ? <AlertTriangle /> : <Info />)}</span>
      <div className="min-w-0 space-y-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'text-fg/80')}>{children}</div>}
      </div>
    </div>
  );
}

/** Number input with a unit shown inside the box (min, m, %, KES). */
export const UnitInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { unit: string; unitPosition?: 'start' | 'end' }>(function UnitInput(
  { unit, unitPosition = 'end', className, ...props },
  ref,
) {
  return (
    <div className="relative">
      {unitPosition === 'start' && <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-fg">{unit}</span>}
      <Input
        ref={ref}
        inputMode="decimal"
        className={cn('tabular', unitPosition === 'end' ? 'pr-16' : unit.length > 2 ? 'pl-12' : 'pl-8', className)}
        {...props}
      />
      {unitPosition === 'end' && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-fg">{unit}</span>}
    </div>
  );
});

/** Form-level error (e.g. a rule across fields). */
export function FormError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  pending,
  onConfirm,
  variant = 'danger',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  pending?: boolean;
  onConfirm: () => void;
  variant?: 'danger' | 'primary';
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant={variant} loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && <div className="text-sm text-muted-fg">{description}</div>}
    </Dialog>
  );
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-muted-fg', className)}>{children}</span>;
}

export const dash = <span className="text-muted-fg">–</span>;
