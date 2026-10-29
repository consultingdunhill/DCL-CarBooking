import { shortName } from '@carbooking/core';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import { useFormat } from '@/lib/format';
import type { Booking } from '@/lib/types';
import { Badge, BookingStatusBadge } from './ui/badge';

/** One trip in a list. */
export function BookingCard({ booking: b, meId }: { booking: Booking; meId: string }) {
  const fmt = useFormat();
  const stops = b.stops.filter((s) => s.status !== 'PROPOSED' && s.status !== 'REJECTED');
  const role = b.ownerId === meId ? null : b.passengers.some((p) => p.user.id === meId) ? 'Passenger' : b.joinRequests.some((j) => j.requester.id === meId) ? 'Join requested' : null;
  return (
    <Link to={`/trips/${b.id}`} className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface p-3 transition-colors hover:bg-surface-2">
      <div className="w-14 shrink-0 text-center">
        <div className="text-xs font-medium text-muted-fg uppercase">{fmt.date(b.startAt).split(' ')[0]}</div>
        <div className="text-xl font-semibold tabular">{fmt.date(b.startAt).split(' ')[1]}</div>
        <div className="text-xs text-muted-fg">{fmt.date(b.startAt).split(' ')[2]}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium tabular">{fmt.window(b.startAt, b.expectedReturnAt)}</span>
          <BookingStatusBadge status={b.status} />
          {b.urgent && <Badge tone="danger">Urgent</Badge>}
          {role && <Badge tone="info">{role}</Badge>}
        </div>
        <p className="mt-0.5 truncate text-sm text-muted-fg">{stops.map((s) => s.label ?? s.address).join(' → ')}</p>
        <p className="truncate text-xs text-muted-fg">
          {b.car.registration}
          {b.ownerId !== meId && ` · ${shortName(b.owner.name)}'s trip`}
        </p>
      </div>
      <ChevronRight className="size-5 shrink-0 text-muted-fg" />
    </Link>
  );
}
