import * as T from '@radix-ui/react-tabs';
import { Loader2 } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-muted-fg', className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-muted', className)} />;
}

export function PageLoader() {
  return (
    <div className="flex h-full min-h-40 items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
      {icon && <div className="mb-1 rounded-full bg-muted p-3 text-muted-fg [&_svg]:size-6">{icon}</div>}
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-fg">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p className="font-medium text-danger">Couldn't load this</p>
      <p className="text-sm text-muted-fg">{error instanceof Error ? error.message : 'Unknown error'}</p>
      {retry && (
        <button className="text-sm font-medium text-primary hover:underline" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Title row at the top of a page. */
export function PageHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-5 flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-fg">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A labelled number. */
export function Stat({ label, value, hint, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-xs font-medium tracking-wide text-muted-fg uppercase">{label}</div>
      <div className="tabular mt-1 text-xl font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-fg">{hint}</div>}
    </div>
  );
}

/** Key/value rows for detail panels. */
export function Dl({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-fg">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export const Tabs = T.Root;
export function TabsList({ className, ...props }: T.TabsListProps) {
  return <T.List className={cn('inline-flex gap-1 rounded-lg bg-muted p-1', className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: T.TabsTriggerProps) {
  return (
    <T.Trigger
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium text-muted-fg transition-colors hover:text-fg',
        'data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  );
}
export const TabsContent = T.Content;

/** Simple responsive table. */
export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  // `relative` keeps absolutely positioned cells (sr-only labels) inside the scroller;
  // otherwise they widen the page, and on phones dialogs stretch to match.
  return (
    <div className="relative overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  );
}
export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('border-b border-border px-3 py-2.5 text-left text-xs font-medium tracking-wide whitespace-nowrap text-muted-fg uppercase', className)} {...props} />;
}
export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('border-b border-border px-3 py-2.5 align-middle', className)} {...props} />;
}
