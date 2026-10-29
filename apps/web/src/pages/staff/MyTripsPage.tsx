import { CalendarPlus, History } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { BookingCard } from '@/components/BookingCard';
import { Page } from '@/components/Shell';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/form';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { useMe } from '@/lib/auth';
import { useBookings } from '@/lib/queries';

const UPCOMING = ['PENDING', 'APPROVED', 'IN_PROGRESS', 'AWAITING_ODOMETER'];

export function MyTripsPage() {
  const me = useMe();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const q = useBookings('mine');
  const all = q.data ?? [];
  const upcoming = all.filter((b) => UPCOMING.includes(b.status)).sort((a, b) => a.startAt.localeCompare(b.startAt));
  const past = all.filter((b) => !UPCOMING.includes(b.status));
  const list = tab === 'upcoming' ? upcoming : past;

  return (
    <Page>
      <PageHeader
        title="My trips"
        description="Trips you booked, are joining, or asked to join."
        actions={
          <Button asChild>
            <Link to="/">
              <CalendarPlus /> Book a trip
            </Link>
          </Button>
        }
      />
      <Segmented
        className="mb-4"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'upcoming', label: `Upcoming${upcoming.length ? ` (${upcoming.length})` : ''}` },
          { value: 'past', label: 'Past' },
        ]}
      />
      {q.isLoading ? (
        <div className="grid gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={<History />} title={tab === 'upcoming' ? 'No upcoming trips' : 'No past trips yet'} description={tab === 'upcoming' ? 'Book a trip, or ask to add your stop to someone else\'s from the calendar.' : undefined} />
      ) : (
        <div className="grid gap-2">
          {list.map((b) => (
            <BookingCard key={b.id} booking={b} meId={me.id} />
          ))}
        </div>
      )}
    </Page>
  );
}
