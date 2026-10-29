import { addDaysToDateKey, shortName, type BookingStatus } from '@carbooking/core';
import { CalendarDays, Car as CarIcon, ChevronLeft, ChevronRight, UserRound, Users, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { Page } from '@/components/Shell';
import { ContactButtons } from '@/components/ops/ContactButtons';
import { useElementWidth, useMediaQuery, useNow } from '@/components/ops/hooks';
import { Badge, BookingStatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Segmented } from '@/components/ui/form';
import { EmptyState, ErrorState, PageHeader, Skeleton, Spinner } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBookings, useReference } from '@/lib/queries';
import type { Booking } from '@/lib/types';
import { cn, initials } from '@/lib/utils';

type View = 'day' | 'week';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

function keyParts(dateKey: string) {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  return { y, m, d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
const dayMonth = (k: string) => {
  const p = keyParts(k);
  return `${p.d} ${MONTHS[p.m - 1]}`;
};
const hhmmToHours = (s: string) => {
  const [h, m] = s.split(':').map(Number) as [number, number];
  return h + m / 60;
};

const BAR_STYLE: Partial<Record<BookingStatus, { cls: string; style?: CSSProperties; label: string }>> = {
  PENDING: {
    cls: 'border border-dashed border-warning text-warning',
    style: { backgroundImage: 'repeating-linear-gradient(135deg, var(--warning-bg) 0 6px, var(--surface) 6px 12px)' },
    label: 'Pending approval',
  },
  APPROVED: { cls: 'bg-primary text-primary-fg', label: 'Approved' },
  IN_PROGRESS: { cls: 'bg-info text-surface', label: 'In progress' },
  AWAITING_ODOMETER: { cls: 'bg-warning text-surface', label: 'Needs odometer' },
  COMPLETED: { cls: 'border border-border bg-muted text-muted-fg', label: 'Completed' },
};
const barStyle = (s: BookingStatus) => BAR_STYLE[s] ?? BAR_STYLE.COMPLETED!;
const OVERDUE_STYLE: CSSProperties = { backgroundImage: 'repeating-linear-gradient(135deg, var(--danger) 0 3px, transparent 3px 8px)' };

interface Segment {
  day: string;
  start: number;
  end: number;
}
interface Piece {
  left: number;
  width: number;
  clipL: boolean;
  clipR: boolean;
}
interface Bar {
  booking: Booking;
  lane: number;
  pieces: Piece[];
  overdue: Piece[];
}
interface Row {
  id: string;
  kind: 'car' | 'driver';
  title: string;
  subtitle: string;
  maintenance?: boolean;
  bars: Bar[];
  lanes: number;
}

/** Gantt-style timeline: one row per car, plus the driver. All times in the office timezone. */
export function CalendarPage() {
  const fmt = useFormat();
  const { isAdmin } = useAuth();
  const ref = useReference();
  const wide = useMediaQuery('(min-width: 640px)');
  const [view, setView] = useState<View>(() => (window.matchMedia('(min-width: 640px)').matches ? 'week' : 'day'));
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Booking | null>(null);
  const now = useNow(60_000);
  const today = fmt.dateKey(new Date(now));
  const day = anchor ?? today;

  const days = useMemo(() => {
    if (view === 'day') return [day];
    const start = addDaysToDateKey(day, -((keyParts(day).weekday + 6) % 7)); // weeks start on Monday
    return Array.from({ length: 7 }, (_, i) => addDaysToDateKey(start, i));
  }, [view, day]);
  const from = fmt.toIso(days[0]!, '00:00');
  const to = fmt.toIso(addDaysToDateKey(days[days.length - 1]!, 1), '00:00');
  const bookings = useBookings('calendar', { from, to });

  const [scrollCallbackRef, containerW, scrollRef] = useElementWidth();
  const carColW = wide ? 168 : 100;
  const avail = Math.max(200, containerW - carColW);

  const workingHours = ref.data?.settings.workingHours;
  const list = bookings.data;

  const model = useMemo(() => {
    const hourOf = (ms: number) => hhmmToHours(fmt.timeKey(new Date(ms)));
    const dayStart = (d: string) => Date.parse(fmt.toIso(d, '00:00'));

    // Visible hours: working hours ±1 h, stretched to fit any booking in range.
    let lo = Infinity;
    let hi = -Infinity;
    for (const d of days) {
      for (const [a, b] of workingHours?.[keyParts(d).weekday] ?? []) {
        lo = Math.min(lo, hhmmToHours(a));
        hi = Math.max(hi, hhmmToHours(b));
      }
    }
    if (!Number.isFinite(lo)) [lo, hi] = [8, 18];
    lo -= 1;
    hi += 1;
    const span = (b: Booking) => {
      const s = Date.parse(b.startAt);
      let e = Date.parse(b.expectedReturnAt);
      if (b.status === 'IN_PROGRESS' && b.trip?.etaAt) e = Math.max(e, Date.parse(b.trip.etaAt));
      return { s, e };
    };
    for (const b of list ?? []) {
      const { s, e } = span(b);
      for (const d of days) {
        const ds = dayStart(d);
        const de = dayStart(addDaysToDateKey(d, 1));
        if (e <= ds || s >= de) continue;
        lo = Math.min(lo, s <= ds ? 0 : hourOf(s));
        hi = Math.max(hi, e >= de ? 24 : hourOf(e) || 24);
      }
    }
    const hStart = Math.max(0, Math.floor(lo));
    const hEnd = Math.min(24, Math.ceil(hi));
    const hours = hEnd - hStart;

    const segs: Segment[] = days.map((d) => ({
      day: d,
      start: Date.parse(fmt.toIso(d, `${pad(hStart)}:00`)),
      end: hEnd >= 24 ? dayStart(addDaysToDateKey(d, 1)) : Date.parse(fmt.toIso(d, `${pad(hEnd)}:00`)),
    }));
    const hourPx = view === 'day' ? Math.max(wide ? 56 : 52, avail / hours) : Math.max(wide ? 120 : 132, avail / 7) / hours;
    const segW = hourPx * hours;
    const totalW = segW * segs.length;

    const xOf = (t: number): number | null => {
      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i]!;
        if (t >= sg.start && t <= sg.end) return i * segW + ((t - sg.start) / (sg.end - sg.start)) * segW;
      }
      return null;
    };
    const piecesOf = (s: number, e: number): Piece[] => {
      const out: Piece[] = [];
      segs.forEach((sg, i) => {
        const a = Math.max(s, sg.start);
        const b = Math.min(e, sg.end);
        if (b <= a) return;
        const left = i * segW + ((a - sg.start) / (sg.end - sg.start)) * segW;
        const width = ((b - a) / (sg.end - sg.start)) * segW;
        out.push({ left, width: Math.max(6, width), clipL: s < sg.start, clipR: e > sg.end });
      });
      return out;
    };

    const toBars = (items: Booking[]) => {
      const sorted = [...items].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
      const laneEnds: number[] = [];
      const bars: Bar[] = sorted.map((b) => {
        const { s, e } = span(b);
        const overdueEnd = b.status === 'IN_PROGRESS' && now > e ? now : null;
        const end = overdueEnd ?? e;
        let lane = laneEnds.findIndex((le) => le <= s);
        if (lane < 0) lane = laneEnds.push(end) - 1;
        else laneEnds[lane] = end;
        return { booking: b, lane, pieces: piecesOf(s, e), overdue: overdueEnd ? piecesOf(e, overdueEnd) : [] };
      });
      return { bars: bars.filter((b) => b.pieces.length || b.overdue.length), lanes: Math.max(1, laneEnds.length) };
    };

    const cars = [...(ref.data?.cars ?? [])];
    for (const b of list ?? []) {
      if (!cars.some((c) => c.id === b.carId)) cars.push({ ...b.car, fuelType: 'PETROL', currentOdometer: 0, homeOfficeId: null, notes: null, seats: b.car.seats });
    }
    const rows: Row[] = cars.map((c) => ({
      id: c.id,
      kind: 'car',
      title: c.registration,
      subtitle: `${c.make} ${c.model}`,
      maintenance: c.status === 'MAINTENANCE',
      ...toBars((list ?? []).filter((b) => b.carId === c.id)),
    }));
    const driver = ref.data?.drivers[0];
    if (driver && cars.length) rows.push({ id: 'driver', kind: 'driver', title: 'Driver', subtitle: shortName(driver.name), ...toBars(list ?? []) });

    // Shading outside working hours, per day, in local hours.
    const shade: { left: number; width: number }[] = [];
    segs.forEach((sg, i) => {
      const windows = (workingHours?.[keyParts(sg.day).weekday] ?? [])
        .map(([a, b]) => [Math.max(hStart, hhmmToHours(a)), Math.min(hEnd, hhmmToHours(b))] as const)
        .filter(([a, b]) => b > a)
        .sort((a, b) => a[0] - b[0]);
      let cur = hStart;
      for (const [a, b] of windows) {
        if (a > cur) shade.push({ left: i * segW + (cur - hStart) * hourPx, width: (a - cur) * hourPx });
        cur = Math.max(cur, b);
      }
      if (cur < hEnd) shade.push({ left: i * segW + (cur - hStart) * hourPx, width: (hEnd - cur) * hourPx });
    });

    return { hStart, hEnd, hours, hourPx, segW, totalW, segs, rows, shade, xOf };
  }, [days, list, workingHours, ref.data, fmt, view, wide, avail, now]);

  const nowX = model.xOf(now);
  const headerH = view === 'day' ? 34 : 54;
  const laneH = view === 'day' ? 48 : 36;
  const driverLaneH = 30;

  // Bring "now" (or the first booking) into view when the period changes.
  const ready = containerW > 0 && !bookings.isLoading;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !ready) return;
    const firstBar = model.rows.flatMap((r) => r.bars.flatMap((b) => b.pieces)).sort((a, b) => a.left - b.left)[0];
    const target = nowX ?? firstBar?.left ?? 0;
    el.scrollLeft = Math.max(0, target - avail * 0.3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, day, ready]);

  const step = view === 'day' ? 1 : 7;
  const title =
    view === 'day'
      ? fmt.date(fmt.toIso(day, '12:00'))
      : `${dayMonth(days[0]!)} – ${dayMonth(days[6]!)} ${keyParts(days[6]!).y}`;
  const isCurrent = days.includes(today);

  const tickEvery = model.hourPx * 3 >= 30 ? 3 : model.hourPx * 6 >= 30 ? 6 : 0;

  return (
    <Page wide>
      <PageHeader
        title="Calendar"
        description="Who has which car, and when. Times are East Africa Time."
        actions={
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week' },
            ]}
          />
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="icon" onClick={() => setAnchor(addDaysToDateKey(day, -step))} aria-label={view === 'day' ? 'Previous day' : 'Previous week'}>
            <ChevronLeft />
          </Button>
          <Button variant="secondary" size="icon" onClick={() => setAnchor(addDaysToDateKey(day, step))} aria-label={view === 'day' ? 'Next day' : 'Next week'}>
            <ChevronRight />
          </Button>
        </div>
        <Button variant={isCurrent ? 'ghost' : 'secondary'} onClick={() => setAnchor(null)} disabled={isCurrent && !anchor}>
          Today
        </Button>
        <h2 className="ml-1 flex items-center gap-2 text-base font-semibold sm:text-lg">
          {title}
          {bookings.isFetching && <Spinner className="size-4" />}
        </h2>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted-fg">
          <CalendarDays className="size-4" />
          <span className="sr-only">Go to date</span>
          <Input type="date" value={day} onChange={(e) => e.target.value && setAnchor(e.target.value)} className="h-9 w-auto" />
        </label>
      </div>

      {ref.isError ? (
        <ErrorState error={ref.error} retry={() => void ref.refetch()} />
      ) : bookings.isError ? (
        <ErrorState error={bookings.error} retry={() => void bookings.refetch()} />
      ) : ref.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : model.rows.length === 0 ? (
        <EmptyState icon={<CarIcon />} title="No cars set up yet" description="Once an admin adds the cars, their bookings show here." />
      ) : (
        <div ref={scrollCallbackRef} className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
          <div className="relative" style={{ width: carColW + model.totalW }}>
            {/* Background: non-working hours, hour lines, day separators */}
            <div className="pointer-events-none absolute bottom-0" style={{ left: carColW, top: headerH, width: model.totalW }} aria-hidden>
              {model.shade.map((s, i) => (
                <div key={i} className="absolute inset-y-0 bg-muted/70" style={{ left: s.left, width: s.width }} />
              ))}
              {model.segs.map((sg, i) =>
                Array.from({ length: model.hours }, (_, h) => {
                  const dayLine = h === 0 && i > 0;
                  if (!dayLine && view === 'week' && (h === 0 || (tickEvery && h % tickEvery !== 0) || !tickEvery)) return null;
                  return (
                    <div
                      key={`${i}-${h}`}
                      className={cn('absolute inset-y-0 border-l', dayLine ? 'border-border' : 'border-border/50')}
                      style={{ left: i * model.segW + h * model.hourPx }}
                    />
                  );
                }),
              )}
            </div>

            {/* Header */}
            <div className="relative flex border-b border-border" style={{ height: headerH }}>
              <div className="sticky left-0 z-20 flex items-end border-r border-border bg-surface px-3 pb-1.5 text-xs font-medium tracking-wide text-muted-fg uppercase" style={{ width: carColW, minWidth: carColW }}>
                Car
              </div>
              <div className="relative" style={{ width: model.totalW }}>
                {model.segs.map((sg, i) => {
                  const p = keyParts(sg.day);
                  const isToday = sg.day === today;
                  return (
                    <div key={sg.day} className={cn('absolute inset-y-0', i > 0 && 'border-l border-border')} style={{ left: i * model.segW, width: model.segW }}>
                      {view === 'week' && (
                        <button
                          type="button"
                          onClick={() => {
                            setAnchor(sg.day);
                            setView('day');
                          }}
                          className={cn('flex h-7 w-full items-center gap-1.5 px-2 text-left text-xs font-semibold hover:bg-muted', isToday ? 'text-primary' : 'text-fg')}
                          title={`Show ${fmt.date(fmt.toIso(sg.day, '12:00'))}`}
                        >
                          {WEEKDAYS[p.weekday]} {p.d}
                          {isToday && <span className="size-1.5 rounded-full bg-primary" aria-label="Today" />}
                        </button>
                      )}
                      {(view === 'day' || tickEvery > 0) &&
                        Array.from({ length: model.hours }, (_, h) => {
                          const hour = model.hStart + h;
                          if (view === 'week' && h % tickEvery !== 0) return null;
                          return (
                            <span
                              key={h}
                              className="tabular absolute bottom-1.5 text-[11px] text-muted-fg"
                              style={{ left: h * model.hourPx + 4 }}
                            >
                              {view === 'day' ? `${pad(hour)}:00` : pad(hour)}
                            </span>
                          );
                        })}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Rows */}
            {model.rows.map((row) => {
              const lh = row.kind === 'driver' ? driverLaneH : laneH;
              const barH = lh - 8;
              const rowH = row.lanes * lh + 8;
              return (
                <div key={row.id} className={cn('relative flex border-b border-border last:border-b-0', row.kind === 'driver' && 'border-t border-t-border')}>
                  <div
                    className="sticky left-0 z-20 flex flex-col justify-center gap-0.5 border-r border-border bg-surface px-3 py-2"
                    style={{ width: carColW, minWidth: carColW, minHeight: rowH }}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      {row.kind === 'driver' && <UserRound className="size-3.5 text-muted-fg" />}
                      <span className="truncate">{row.title}</span>
                    </span>
                    <span className="truncate text-xs text-muted-fg">{row.subtitle}</span>
                    {row.maintenance && (
                      <Badge tone="warning" className="mt-0.5 self-start">
                        <Wrench className="size-3" /> {wide ? 'Maintenance' : 'Maint.'}
                      </Badge>
                    )}
                  </div>
                  <div className="relative" style={{ width: model.totalW, height: rowH }}>
                    {row.bars.map((bar) => {
                      const b = bar.booking;
                      const st = barStyle(b.status);
                      const owner = shortName(b.owner.name);
                      const timeText = fmt.window(b.startAt, b.trip?.etaAt && b.status === 'IN_PROGRESS' && b.trip.etaAt > b.expectedReturnAt ? b.trip.etaAt : b.expectedReturnAt);
                      const dest = b.stops.find((s) => s.status !== 'REJECTED' && s.status !== 'PROPOSED');
                      const destLabel = dest ? dest.label || dest.property?.ref || dest.address.split(',').slice(-1)[0]!.trim() : '';
                      const label = row.kind === 'driver' ? b.car.registration : owner;
                      const desc = `${b.owner.name}, ${b.car.registration}, ${fmt.when(b.startAt, b.expectedReturnAt)}, ${st.label}`;
                      const top = 4 + bar.lane * lh + (lh - barH) / 2;
                      return (
                        <div key={b.id}>
                          {bar.pieces.map((p, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setSelected(b)}
                              title={desc}
                              aria-label={desc}
                              className={cn(
                                'absolute z-[1] flex flex-col justify-center overflow-hidden px-1.5 text-left text-xs leading-tight shadow-sm transition-[filter,box-shadow] hover:brightness-95 hover:shadow-card focus-visible:z-[2]',
                                st.cls,
                                !p.clipL && 'rounded-l-md',
                                !p.clipR && !bar.overdue.length && 'rounded-r-md',
                              )}
                              style={{ left: p.left, width: p.width, top, height: barH, ...st.style }}
                            >
                              {p.width >= 20 && p.width < 48 && row.kind === 'car' && <span className="truncate text-center font-semibold">{initials(b.owner.name)}</span>}
                              {(p.width >= 48 || (row.kind === 'driver' && p.width >= 36)) && (
                                <>
                                  <span className="truncate font-semibold">{label}</span>
                                  {view === 'day' && row.kind === 'car' && p.width >= 90 && (
                                    <span className="tabular truncate opacity-90">
                                      {timeText}
                                      {destLabel && p.width >= 170 ? ` · ${destLabel}` : ''}
                                    </span>
                                  )}
                                </>
                              )}
                            </button>
                          ))}
                          {bar.overdue.map((p, i) => (
                            <button
                              key={`o${i}`}
                              type="button"
                              onClick={() => setSelected(b)}
                              title={`${desc}: overdue`}
                              aria-label={`${desc}: overdue`}
                              className={cn('absolute z-[1] border border-danger/60 bg-danger-bg opacity-90', !p.clipR && 'rounded-r-md')}
                              style={{ left: p.left, width: p.width, top, height: barH, ...OVERDUE_STYLE }}
                            />
                          ))}
                        </div>
                      );
                    })}
                    {bookings.isLoading && row.kind === 'car' && <Skeleton className="absolute inset-x-2 top-2 bottom-2 opacity-60" />}
                  </div>
                </div>
              );
            })}

            {nowX != null && (
              <div className="pointer-events-none absolute bottom-0 z-10 w-0.5 bg-danger" style={{ left: carColW + nowX - 1, top: headerH - 6 }} aria-hidden>
                <span className="absolute -top-1 -left-[3px] size-2 rounded-full bg-danger" />
              </div>
            )}
          </div>
        </div>
      )}

      {!bookings.isLoading && !bookings.isError && model.rows.length > 0 && (bookings.data?.length ?? 0) === 0 && (
        <p className="mt-3 text-sm text-muted-fg">No bookings {view === 'day' ? 'on this day' : 'this week'}. Every car is free.</p>
      )}

      <Legend />

      {selected && <BookingDialog booking={selected} isAdmin={isAdmin} onClose={() => setSelected(null)} />}
    </Page>
  );
}

function Legend() {
  const items: [string, string, CSSProperties | undefined][] = [
    ['Pending approval', barStyle('PENDING').cls, barStyle('PENDING').style],
    ['Approved', barStyle('APPROVED').cls, undefined],
    ['In progress', barStyle('IN_PROGRESS').cls, undefined],
    ['Needs odometer', barStyle('AWAITING_ODOMETER').cls, undefined],
    ['Completed', barStyle('COMPLETED').cls, undefined],
    ['Overdue', 'border border-danger/60 bg-danger-bg', OVERDUE_STYLE],
    ['Outside working hours', 'border border-border bg-muted/70', undefined],
  ];
  return (
    <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-fg" aria-label="Legend">
      {items.map(([label, cls, style]) => (
        <li key={label} className="flex items-center gap-1.5">
          <span className={cn('h-3 w-5 rounded-sm', cls)} style={style} />
          {label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="h-3 w-0.5 bg-danger" />
        Now
      </li>
    </ul>
  );
}

function BookingDialog({ booking: b, isAdmin, onClose }: { booking: Booking; isAdmin: boolean; onClose: () => void }) {
  const fmt = useFormat();
  const stops = b.stops.filter((s) => s.status !== 'REJECTED' && s.status !== 'PROPOSED').sort((a, c) => a.seq - c.seq);
  const eta = b.status === 'IN_PROGRESS' && b.trip?.etaAt && b.trip.etaAt > b.expectedReturnAt ? b.trip.etaAt : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${shortName(b.owner.name)} · ${b.car.registration}`}
      description={fmt.when(b.startAt, b.expectedReturnAt)}
      footer={
        <>
          {isAdmin && b.status === 'PENDING' && (
            <Button asChild variant="secondary">
              <Link to="/admin/approvals">Review in Approvals</Link>
            </Button>
          )}
          {isAdmin && b.trip && (
            <Button asChild variant="secondary">
              <Link to={`/admin/trips/${b.trip.id}`}>Trip detail &amp; route</Link>
            </Button>
          )}
          <Button asChild>
            <Link to={`/trips/${b.id}`}>Open trip</Link>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <BookingStatusBadge status={b.status} />
          {eta && <Badge tone="info">ETA extended to {fmt.time(eta)}</Badge>}
        </div>

        <section className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium tracking-wide text-muted-fg uppercase">Trip owner</div>
            <div className="font-medium">{b.owner.name}</div>
            {b.owner.phone && <div className="tabular text-sm text-muted-fg">{b.owner.phone}</div>}
          </div>
          <ContactButtons phone={b.owner.phone} name={b.owner.name} />
        </section>

        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-fg">Car</dt>
          <dd>
            {b.car.registration} <span className="text-muted-fg">· {b.car.make} {b.car.model}</span>
          </dd>
          <dt className="text-muted-fg">When</dt>
          <dd className="tabular">{fmt.when(b.startAt, b.expectedReturnAt)}</dd>
          <dt className="text-muted-fg">Driver</dt>
          <dd>{b.driver.name}</dd>
          {b.plannedDistanceKm != null && (
            <>
              <dt className="text-muted-fg">Planned</dt>
              <dd className="tabular">
                {fmt.km(b.plannedDistanceKm)}
                {b.plannedDurationMin != null ? `, about ${fmt.duration(b.plannedDurationMin)} driving` : ''}
              </dd>
            </>
          )}
        </dl>

        <section>
          <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-fg uppercase">Stops ({stops.length})</h3>
          {stops.length === 0 ? (
            <p className="text-sm text-muted-fg">No stops listed.</p>
          ) : (
            <ol className="flex flex-col gap-2.5">
              {stops.map((s, i) => (
                <li key={s.id} className="flex gap-3">
                  <span className="tabular mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-fg">{i + 1}</span>
                  <div className="min-w-0 text-sm">
                    <div className="font-medium">{s.label || s.address}</div>
                    {s.label && <div className="text-muted-fg">{s.address}</div>}
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-fg">
                      <span>{s.reason.label}</span>
                      {s.property && (
                        <span>
                          · {s.property.ref}
                          {s.property.client ? ` (${s.property.client.name})` : ''}
                        </span>
                      )}
                      {s.status === 'SKIPPED' && <Badge>Skipped</Badge>}
                      {s.arrivedAt && <span className="tabular">· Arrived {fmt.time(s.arrivedAt)}</span>}
                      {s.departedAt && <span className="tabular">· Left {fmt.time(s.departedAt)}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-fg uppercase">
            <Users className="size-3.5" /> Passengers
          </h3>
          {b.passengers.length === 0 ? (
            <p className="text-sm text-muted-fg">Just the trip owner and the driver.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {b.passengers.map((p) => (
                <li key={p.user.id}>
                  <Badge>{p.user.name}</Badge>
                </li>
              ))}
            </ul>
          )}
          {b.joinRequests.length > 0 && (
            <p className="mt-2 text-xs text-warning">
              {b.joinRequests.length} request{b.joinRequests.length > 1 ? 's' : ''} to join waiting for approval
            </p>
          )}
        </section>

        {b.notes && (
          <section>
            <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-fg uppercase">Notes</h3>
            <p className="text-sm whitespace-pre-wrap">{b.notes}</p>
          </section>
        )}
      </div>
    </Dialog>
  );
}
