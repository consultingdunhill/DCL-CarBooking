import { addDaysToDateKey } from '@carbooking/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ClipboardList, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Page } from '@/components/Shell';
import { END_METHOD_LABELS } from '@/components/ops/tracking';
import { Badge, BookingStatusBadge, TrackingBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select, Switch } from '@/components/ui/form';
import { EmptyState, ErrorState, PageHeader, Skeleton, Spinner, Stat, Table, Td, Th } from '@/components/ui/misc';
import { get, qs } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useReference } from '@/lib/queries';
import type { AdminTripRow } from '@/lib/types';
import { cn } from '@/lib/utils';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'AWAITING_ODOMETER', label: 'Needs odometer' },
  { value: 'COMPLETED', label: 'Completed' },
];

const hasIssue = (r: AdminTripRow) => r.issues > 0 || r.varianceFlag || r.unloggedKm > 0 || r.booking.status === 'AWAITING_ODOMETER';

/** Trip history for admins: odometer vs GPS, interruptions, how each trip ended. */
export function TripsPage() {
  const fmt = useFormat();
  const navigate = useNavigate();
  const ref = useReference();
  const today = fmt.dateKey(new Date());
  const [from, setFrom] = useState(() => addDaysToDateKey(today, -29));
  const [to, setTo] = useState(today);
  const [carId, setCarId] = useState('');
  const [status, setStatus] = useState('');
  const [issuesOnly, setIssuesOnly] = useState(false);

  const rangeError = from && to && from > to ? 'The start date is after the end date' : null;
  const params = {
    from: from ? fmt.toIso(from, '00:00') : undefined,
    to: to ? fmt.toIso(addDaysToDateKey(to, 1), '00:00') : undefined,
    carId: carId || undefined,
    status: status || undefined,
  };
  const trips = useQuery({
    queryKey: ['admin-trips', params],
    queryFn: () => get<AdminTripRow[]>(`/admin/trips${qs(params)}`),
    placeholderData: keepPreviousData,
    enabled: !rangeError,
  });

  const all = trips.data ?? [];
  const rows = issuesOnly ? all.filter(hasIssue) : all;
  const sum = (f: (r: AdminTripRow) => number | null | undefined) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  const filtered = Boolean(carId || status || issuesOnly || from !== addDaysToDateKey(today, -29) || to !== today);

  const reset = () => {
    setFrom(addDaysToDateKey(today, -29));
    setTo(today);
    setCarId('');
    setStatus('');
    setIssuesOnly(false);
  };

  return (
    <Page wide>
      <PageHeader title="Trip history" description="Every trip with odometer and GPS distance, tracking interruptions and how it ended." />

      <Card className="mb-4 p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]">
          <Field label="From" error={rangeError}>
            {(p) => <Input {...p} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />}
          </Field>
          <Field label="To">
            {(p) => <Input {...p} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />}
          </Field>
          <Field label="Car">
            {(p) => (
              <Select {...p} value={carId} onChange={(e) => setCarId(e.target.value)}>
                <option value="">All cars</option>
                {ref.data?.cars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.registration} · {c.make} {c.model}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Status">
            {(p) => (
              <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="col-span-2 flex items-end justify-between gap-3 md:col-span-4 lg:col-span-1 lg:flex-col lg:items-start lg:justify-end">
            <Switch checked={issuesOnly} onChange={setIssuesOnly} label="Only trips with issues" />
            {filtered && (
              <Button variant="ghost" size="sm" onClick={reset}>
                Reset
              </Button>
            )}
          </div>
        </div>
      </Card>

      {trips.isError ? (
        <ErrorState error={trips.error} retry={() => void trips.refetch()} />
      ) : trips.isLoading || (rangeError && !trips.data) ? (
        rangeError ? null : (
          <div className="space-y-2">
            <Skeleton className="h-20" />
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardList />}
            title={issuesOnly && all.length ? 'No trips with issues in this period' : 'No trips in this period'}
            description="Try a wider date range or clear the filters."
            action={
              filtered ? (
                <Button variant="secondary" onClick={reset}>
                  Reset filters
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <Card className="mb-4 grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Trips" value={rows.length.toLocaleString()} hint={trips.isFetching ? <Spinner className="size-3" /> : undefined} />
            <Stat label="Odometer km" value={fmt.km(sum((r) => r.tripKm))} />
            <Stat label="GPS km" value={fmt.km(sum((r) => r.gpsDistanceKm))} />
            <Stat label="Unlogged km" value={fmt.km(sum((r) => r.unloggedKm))} />
            <Stat label="Variance flags" value={rows.filter((r) => r.varianceFlag).length} hint="Odometer vs GPS" />
            <Stat label="With interruptions" value={rows.filter((r) => r.issues > 0).length} hint="Location off, lost, overdue" />
          </Card>

          {/* Phones: cards */}
          <ul className="space-y-2 md:hidden">
            {rows.map((r) => (
              <li key={r.id}>
                <Link to={`/admin/trips/${r.id}`} className="block rounded-card border border-border bg-surface p-3 shadow-card active:bg-muted">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold">
                        {r.booking.car.registration} <span className="font-normal text-muted-fg">· {r.booking.owner.name}</span>
                      </div>
                      <div className="tabular text-xs text-muted-fg">
                        {fmt.date(r.startedAt)}, {timeSpan(fmt, r)}
                      </div>
                    </div>
                    <BookingStatusBadge status={r.booking.status} />
                  </div>
                  <StopsText r={r} className="mt-1.5 text-sm" />
                  <div className="tabular mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-fg">
                    <span>Odometer {fmt.km(r.tripKm)}</span>
                    <span>GPS {fmt.km(r.gpsDistanceKm)}</span>
                    <VarianceBadge r={r} />
                    {r.unloggedKm > 0 && <span className="text-warning">+{r.unloggedKm} km unlogged</span>}
                    {r.issues > 0 && <Badge tone="danger">{r.issues} interruption{r.issues > 1 ? 's' : ''}</Badge>}
                    {r.endMethod && <span>{END_METHOD_LABELS[r.endMethod]}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* Larger screens: table */}
          <Card className="hidden overflow-hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Car &amp; owner</Th>
                  <Th>Stops</Th>
                  <Th className="text-right">Odometer</Th>
                  <Th className="text-right">GPS</Th>
                  <Th className="text-right">Variance</Th>
                  <Th className="text-right" title="Location off, tracking lost and overdue events">
                    Issues
                  </Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    role="link"
                    aria-label={`Trip on ${fmt.date(r.startedAt)}, ${r.booking.car.registration}, ${r.booking.owner.name}`}
                    onClick={() => navigate(`/admin/trips/${r.id}`)}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/admin/trips/${r.id}`)}
                    className="cursor-pointer transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
                  >
                    <Td className="whitespace-nowrap">
                      <div className="font-medium">{fmt.date(r.startedAt)}</div>
                      <div className="tabular text-xs text-muted-fg">{timeSpan(fmt, r)}</div>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <div className="font-medium">{r.booking.car.registration}</div>
                      <div className="text-xs text-muted-fg">{r.booking.owner.name}</div>
                    </Td>
                    <Td className="max-w-56">
                      <StopsText r={r} />
                    </Td>
                    <Td className="tabular text-right whitespace-nowrap">
                      {fmt.km(r.tripKm)}
                      {r.unloggedKm > 0 && <div className="text-xs text-warning">+{r.unloggedKm} unlogged</div>}
                    </Td>
                    <Td className="tabular text-right whitespace-nowrap">{fmt.km(r.gpsDistanceKm)}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <VarianceBadge r={r} />
                    </Td>
                    <Td className="tabular text-right">{r.issues > 0 ? <Badge tone="danger">{r.issues}</Badge> : <span className="text-muted-fg">–</span>}</Td>
                    <Td>
                      <div className="flex flex-col items-start gap-1">
                        <BookingStatusBadge status={r.booking.status} />
                        {r.booking.status === 'IN_PROGRESS' && <TrackingBadge status={r.trackingStatus} />}
                        {r.endMethod && <span className="text-xs whitespace-nowrap text-muted-fg">{END_METHOD_LABELS[r.endMethod]}</span>}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          {all.length >= 300 && <p className="mt-3 text-sm text-muted-fg">Showing the latest 300 trips. Narrow the date range to see older ones.</p>}
        </>
      )}
    </Page>
  );
}

function timeSpan(fmt: ReturnType<typeof useFormat>, r: AdminTripRow) {
  if (r.endedAt) return fmt.window(r.startedAt, r.endedAt);
  return `${fmt.time(r.startedAt)}, still out`;
}

function StopsText({ r, className }: { r: AdminTripRow; className?: string }) {
  const stops = r.booking.stops;
  if (!stops.length) return <span className={cn('text-muted-fg', className)}>No stops</span>;
  const names = stops.map((s) => s.label || s.address);
  return (
    <div className={cn('min-w-0', className)} title={names.join('\n')}>
      {names.slice(0, 2).map((n, i) => (
        <div key={i} className="truncate">
          {n}
        </div>
      ))}
      {names.length > 2 && <div className="text-xs text-muted-fg">+{names.length - 2} more</div>}
    </div>
  );
}

function VarianceBadge({ r }: { r: AdminTripRow }) {
  if (r.variancePct == null) return <span className="text-muted-fg">–</span>;
  const pct = `${Math.round(r.variancePct)}%`;
  return r.varianceFlag ? (
    <Badge tone="warning" title="Odometer and GPS distance differ by more than the threshold">
      <TriangleAlert className="size-3" /> {pct}
    </Badge>
  ) : (
    <span className="tabular text-muted-fg">{pct}</span>
  );
}
