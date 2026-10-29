import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Page } from '@/components/Shell';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { post } from '@/lib/api';
import { relative } from '@/lib/format';
import { useNotifications } from '@/lib/queries';
import { cn } from '@/lib/utils';

const URGENT = /URGENT|LOST|OVERDUE|LOCATION_OFF/;

export function NotificationsPage() {
  const q = useNotifications();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const markRead = useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) => post('/notifications/read', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const items = q.data?.items ?? [];

  return (
    <Page>
      <PageHeader
        title="Notifications"
        actions={
          (q.data?.unread ?? 0) > 0 && (
            <Button variant="secondary" size="sm" onClick={() => markRead.mutate({ all: true })} loading={markRead.isPending}>
              <CheckCheck /> Mark all read
            </Button>
          )
        }
      />
      {q.isLoading ? (
        <div className="grid gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Bell />} title="Nothing yet" description="Approvals, trip changes and alerts show up here." />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {items.map((n) => (
            <li key={n.id}>
              <button
                className={cn('flex w-full gap-3 px-4 py-3 text-left hover:bg-surface-2', !n.readAt && 'bg-accent/40')}
                onClick={() => {
                  if (!n.readAt) markRead.mutate({ ids: [n.id] });
                  if (n.link) navigate(n.link);
                }}
              >
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : URGENT.test(n.type) ? 'bg-danger' : 'bg-primary')} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className={cn('text-sm', !n.readAt && 'font-semibold')}>{n.title}</span>
                    <span className="shrink-0 text-xs text-muted-fg">{relative(new Date(n.createdAt))}</span>
                  </span>
                  <span className="mt-0.5 block text-sm text-muted-fg">{n.body}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
