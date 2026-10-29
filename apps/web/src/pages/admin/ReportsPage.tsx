import {
  addDaysToDateKey,
  addMonths,
  DEPARTMENT_LABELS,
  DEPARTMENTS,
  REPORT_IDS,
  REPORT_META,
  type ColumnType,
  type Department,
  type ReportCell,
  type ReportColumn,
  type ReportId,
  type ReportResult,
} from '@carbooking/core';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, BarChart3, Download, FileSpreadsheet, Info, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Page } from '@/components/Shell';
import { LineChart } from '@/components/ops/LineChart';
import { PropertyPicker, type PickedProperty } from '@/components/ops/PropertyPicker';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Segmented, Select } from '@/components/ui/form';
import { EmptyState, ErrorState, PageHeader, Skeleton, Spinner, Table, Td, Th } from '@/components/ui/misc';
import { download, errorMessage, get, qs } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useReference } from '@/lib/queries';
import type { AdminUser, Client, VisitReason } from '@/lib/types';
import { cn } from '@/lib/utils';

type Preset = 'this-month' | 'last-month' | 'last-3' | 'ytd' | 'custom';
type ReportResponse = ReportResult & { currency: string; from: string; to: string };

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'last-3', label: 'Last 3 months' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'custom', label: 'Custom dates' },
];

const GROUP_LABELS: Record<string, string> = {
  car: 'Car',
  driver: 'Driver',
  staff: 'Staff',
  department: 'Department',
  reason: 'Reason',
  viewing: 'Each viewing',
  property: 'Property',
  service: 'Service',
  client: 'Client',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NUMERIC: ColumnType[] = ['int', 'number', 'money', 'km', 'percent', 'hours'];

function monthLabel(v: string) {
  const [y, m] = v.split('-').map(Number) as [number, number];
  return `${MONTHS[m - 1] ?? v} ${y}`;
}

function shortDate(k: string) {
  const [y, m, d] = k.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function presetRange(p: Exclude<Preset, 'custom'>, today: string) {
  const month = today.slice(0, 7);
  switch (p) {
    case 'this-month':
      return { from: `${month}-01`, to: today };
    case 'last-month':
      return { from: `${addMonths(month, -1)}-01`, to: addDaysToDateKey(`${month}-01`, -1) };
    case 'last-3':
      return { from: `${addMonths(month, -2)}-01`, to: today };
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

const isReportId = (v: string | null): v is ReportId => v != null && (REPORT_IDS as readonly string[]).includes(v);

/** The eight v1 reports (§4.7), with filters, a trend chart where useful, and CSV/Excel export. */
export function ReportsPage() {
  const fmt = useFormat();
  const ref = useReference();
  const today = fmt.dateKey(new Date());
  const [search, setSearch] = useSearchParams();
  const id: ReportId = isReportId(search.get('report')) ? (search.get('report') as ReportId) : 'fuel-efficiency';
  const setId = (r: ReportId) =>
    setSearch(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('report', r);
        return next;
      },
      { replace: true },
    );

  const [preset, setPreset] = useState<Preset>('last-3');
  const [range, setRange] = useState(() => presetRange('last-3', today));
  const [carId, setCarId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [department, setDepartment] = useState<Department | ''>('');
  const [reasonId, setReasonId] = useState('');
  const [property, setProperty] = useState<PickedProperty | null>(null);
  const [clientId, setClientId] = useState('');
  const [groupByFor, setGroupByFor] = useState<Partial<Record<ReportId, string>>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);
  const navRef = useRef<HTMLElement>(null);

  // On phones the report list is a horizontal strip: keep the chosen one in view.
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [id]);

  const users = useQuery({ queryKey: ['reports', 'users'], queryFn: () => get<AdminUser[]>('/admin/users'), staleTime: 5 * 60_000 });
  const clients = useQuery({ queryKey: ['reports', 'clients'], queryFn: () => get<Client[]>('/clients'), staleTime: 5 * 60_000 });
  const reasons = useQuery({ queryKey: ['reports', 'reasons'], queryFn: () => get<VisitReason[]>('/admin/reasons'), staleTime: 5 * 60_000 });

  const meta = REPORT_META[id];
  const groupOptions = meta.options?.groupBy;
  const groupBy = groupOptions ? (groupByFor[id] ?? groupOptions[0]) : undefined;
  const rangeError = !range.from || !range.to ? 'Choose both dates' : range.from > range.to ? 'The start date is after the end date' : null;

  const params = {
    from: range.from,
    to: range.to,
    carId: carId || undefined,
    staffId: staffId || undefined,
    department: department || undefined,
    reasonId: reasonId || undefined,
    propertyId: property?.id,
    clientId: clientId || undefined,
    groupBy,
  };
  const report = useQuery({
    queryKey: ['report', id, params],
    queryFn: () => get<ReportResponse>(`/reports/${id}${qs(params)}`),
    enabled: !rangeError,
    staleTime: 60_000,
    placeholderData: (prev) => (prev?.id === id ? prev : undefined),
  });

  const activeFilters = [carId, staffId, department, reasonId, property?.id, clientId].filter(Boolean).length;
  const clearFilters = () => {
    setCarId('');
    setStaffId('');
    setDepartment('');
    setReasonId('');
    setProperty(null);
    setClientId('');
  };

  const choosePreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p, today));
  };

  const exportAs = async (format: 'csv' | 'xlsx') => {
    setExporting(format);
    try {
      await download(`/reports/${id}${qs({ ...params, format })}`, `${id}_${range.from}_${range.to}.${format}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(null);
    }
  };

  const seriesOrder = useMemo(() => (ref.data?.cars ?? []).map((c) => `${c.registration} (${c.make} ${c.model})`), [ref.data]);
  const activeUsers = (users.data ?? []).filter((u) => u.active);
  const formerUsers = (users.data ?? []).filter((u) => !u.active);
  const activeReasons = (reasons.data ?? []).filter((r) => r.active);
  const archivedReasons = (reasons.data ?? []).filter((r) => !r.active);

  return (
    <Page wide className="max-w-[1400px]">
      <PageHeader title="Reports" description="Fuel, cost, usage and compliance. Figures are in KES and East Africa Time." />

      <div className="grid gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
        <nav ref={navRef} aria-label="Reports" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0">
          {REPORT_IDS.map((r, i) => (
            <button
              key={r}
              type="button"
              onClick={() => setId(r)}
              aria-current={r === id ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-left text-sm font-medium whitespace-nowrap transition-colors lg:rounded-lg lg:border-transparent lg:py-2 lg:whitespace-normal',
                r === id ? 'border-transparent bg-accent text-accent-fg' : 'border-border text-muted-fg hover:bg-muted hover:text-fg',
              )}
            >
              <span className="tabular hidden w-4 text-xs opacity-70 lg:inline">{i + 1}</span>
              {REPORT_META[r].title}
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-4">
          <Card className="p-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(150px,1fr)_minmax(140px,1fr)_minmax(140px,1fr)] xl:grid-cols-[minmax(150px,200px)_170px_170px_1fr]">
              <Field label="Period" className="col-span-2 sm:col-span-1">
                {(p) => (
                  <Select {...p} value={preset} onChange={(e) => choosePreset(e.target.value as Preset)}>
                    {PRESETS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="From" error={rangeError}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    value={range.from}
                    max={range.to || undefined}
                    onChange={(e) => {
                      setPreset('custom');
                      setRange((r) => ({ ...r, from: e.target.value }));
                    }}
                  />
                )}
              </Field>
              <Field label="To">
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    value={range.to}
                    min={range.from || undefined}
                    onChange={(e) => {
                      setPreset('custom');
                      setRange((r) => ({ ...r, to: e.target.value }));
                    }}
                  />
                )}
              </Field>
              <div className="col-span-2 flex flex-wrap items-end justify-between gap-2 sm:col-span-3 xl:col-span-1 xl:justify-end">
                <Button variant="secondary" className="md:hidden" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
                  <SlidersHorizontal /> Filters{activeFilters ? ` (${activeFilters})` : ''}
                </Button>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => void exportAs('csv')} loading={exporting === 'csv'} disabled={Boolean(rangeError)}>
                    {exporting !== 'csv' && <Download />} CSV
                  </Button>
                  <Button variant="secondary" onClick={() => void exportAs('xlsx')} loading={exporting === 'xlsx'} disabled={Boolean(rangeError)}>
                    {exporting !== 'xlsx' && <FileSpreadsheet />} Excel
                  </Button>
                </div>
              </div>
            </div>

            <div className={cn('mt-3 grid-cols-2 gap-3 border-t border-border pt-3 md:grid md:grid-cols-3 2xl:grid-cols-6', showFilters ? 'grid' : 'hidden')}>
              <Field label="Car">
                {(p) => (
                  <Select {...p} value={carId} onChange={(e) => setCarId(e.target.value)}>
                    <option value="">All cars</option>
                    {ref.data?.cars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.registration}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Staff">
                {(p) => (
                  <Select {...p} value={staffId} onChange={(e) => setStaffId(e.target.value)} disabled={users.isLoading}>
                    <option value="">All staff</option>
                    {activeUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                    {formerUsers.length > 0 && (
                      <optgroup label="No longer active">
                        {formerUsers.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </Select>
                )}
              </Field>
              <Field label="Department">
                {(p) => (
                  <Select {...p} value={department} onChange={(e) => setDepartment(e.target.value as Department | '')}>
                    <option value="">All departments</option>
                    {DEPARTMENTS.map((d) => (
                      <option key={d} value={d}>
                        {DEPARTMENT_LABELS[d]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Visit reason">
                {(p) => (
                  <Select {...p} value={reasonId} onChange={(e) => setReasonId(e.target.value)} disabled={reasons.isLoading}>
                    <option value="">All reasons</option>
                    {activeReasons.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label} ({DEPARTMENT_LABELS[r.department]})
                      </option>
                    ))}
                    {archivedReasons.length > 0 && (
                      <optgroup label="Archived">
                        {archivedReasons.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label} ({DEPARTMENT_LABELS[r.department]})
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </Select>
                )}
              </Field>
              <Field label="Property">{(p) => <PropertyPicker id={p.id} value={property} onChange={setProperty} />}</Field>
              <Field label="Client">
                {(p) => (
                  <Select {...p} value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={clients.isLoading}>
                    <option value="">All clients</option>
                    {clients.data?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {activeFilters > 0 && (
                <div className="col-span-2 flex justify-end md:col-span-3 2xl:col-span-6">
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    Clear {activeFilters} filter{activeFilters > 1 ? 's' : ''}
                  </Button>
                </div>
              )}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  {report.data?.title ?? meta.title}
                  {report.isFetching && <Spinner className="size-4" />}
                </h2>
                <p className="mt-0.5 text-sm text-muted-fg">{report.data?.description ?? meta.description}</p>
                {!rangeError && (
                  <p className="tabular mt-1 text-xs text-muted-fg">
                    {shortDate(range.from)} – {shortDate(range.to)}
                    {report.data && ` · ${report.data.rows.length.toLocaleString()} row${report.data.rows.length === 1 ? '' : 's'}`}
                  </p>
                )}
              </div>
              {groupOptions && (
                <div className="max-w-full overflow-x-auto">
                  <div className="mb-1 text-xs font-medium text-muted-fg">Group by</div>
                  <Segmented<string>
                    value={groupBy!}
                    onChange={(g) => setGroupByFor((m) => ({ ...m, [id]: g }))}
                    options={groupOptions.map((g) => ({ value: g, label: GROUP_LABELS[g] ?? g }))}
                  />
                </div>
              )}
            </div>

            {rangeError ? (
              <EmptyState icon={<BarChart3 />} title="Choose a period" description={rangeError} />
            ) : report.isError ? (
              <ErrorState error={report.error} retry={() => void report.refetch()} />
            ) : report.isLoading || !report.data ? (
              <div className="space-y-2 p-5">
                <Skeleton className="h-48" />
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : (
              <ReportBody key={`${id}:${groupBy ?? ''}`} result={report.data} seriesOrder={seriesOrder} />
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}

function ReportBody({ result, seriesOrder }: { result: ReportResponse; seriesOrder: string[] }) {
  const fmt = useFormat();
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  const format = (v: ReportCell, type: ColumnType): string => {
    if (v == null || v === '') return '–';
    if (typeof v === 'string' && type !== 'date' && type !== 'month') return v;
    switch (type) {
      case 'money':
        return fmt.money(Number(v));
      case 'km':
        return fmt.km(Number(v));
      case 'percent':
        return `${Number(v).toLocaleString('en-KE', { maximumFractionDigits: 1 })}%`;
      case 'hours':
        return `${Number(v).toLocaleString('en-KE', { maximumFractionDigits: 2 })} h`;
      case 'date':
        return fmt.dateTime(String(v));
      case 'month':
        return monthLabel(String(v));
      case 'int':
      case 'number':
        return Number(v).toLocaleString('en-KE', { maximumFractionDigits: 2 });
      default:
        return String(v);
    }
  };

  const rows = useMemo(() => {
    if (!sort) return result.rows;
    return [...result.rows].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sort.dir;
      return String(x).localeCompare(String(y), 'en', { numeric: true }) * sort.dir;
    });
  }, [result.rows, sort]);

  const toggleSort = (c: ReportColumn) =>
    setSort((s) => (s?.key !== c.key ? { key: c.key, dir: NUMERIC.includes(c.type) ? -1 : 1 } : s.dir === (NUMERIC.includes(c.type) ? -1 : 1) ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : null));

  const chart = result.chart;
  const chartCol = chart ? result.columns.find((c) => c.key === chart.y) : undefined;
  const formatY = (v: number) => (chartCol?.type === 'money' ? fmt.money(v) : v.toLocaleString('en-KE', { maximumFractionDigits: 2 }));

  return (
    <div>
      {chart && result.rows.length > 0 && (
        <section className="border-b border-border px-5 py-4">
          <h3 className="mb-3 text-sm font-semibold">{chart.label}</h3>
          <LineChart
            rows={result.rows}
            x={chart.x}
            y={chart.y}
            seriesBy={chart.seriesBy}
            label={chart.label}
            seriesOrder={seriesOrder}
            formatX={monthLabel}
            formatXTick={(v, i) => {
              const [y, m] = v.split('-').map(Number) as [number, number];
              return i === 0 || m === 1 ? `${MONTHS[m - 1]} ${y}` : MONTHS[m - 1]!;
            }}
            formatY={formatY}
          />
        </section>
      )}

      {result.rows.length === 0 ? (
        <EmptyState icon={<BarChart3 />} title="No data for this period and these filters" description="Try a longer period or fewer filters." />
      ) : (
        <Table className="min-w-max">
          <thead>
            <tr>
              {result.columns.map((c) => {
                const numeric = NUMERIC.includes(c.type);
                const active = sort?.key === c.key;
                return (
                  <Th key={c.key} className={cn('bg-surface-2 p-0', numeric && 'text-right')} aria-sort={active ? (sort!.dir === 1 ? 'ascending' : 'descending') : undefined}>
                    <button
                      type="button"
                      onClick={() => toggleSort(c)}
                      className={cn('inline-flex w-full items-center gap-1 px-3 py-2.5 uppercase hover:text-fg', numeric && 'justify-end', active && 'text-fg')}
                      title={`Sort by ${c.label}`}
                    >
                      {c.label}
                      {active && (sort!.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  </Th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-muted/40">
                {result.columns.map((c, ci) => {
                  const numeric = NUMERIC.includes(c.type);
                  const raw = r[c.key] ?? null;
                  return (
                    <Td key={c.key} className={cn(numeric ? 'tabular text-right whitespace-nowrap' : 'max-w-80', ci === 0 && 'font-medium', (c.type === 'date' || c.type === 'month') && 'tabular whitespace-nowrap')}>
                      {format(raw, c.type)}
                    </Td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {result.notes.length > 0 && (
        <ul className="space-y-1.5 border-t border-border px-5 py-4 text-sm">
          {result.notes.map((n, i) => {
            const caveat = /^provisional/i.test(n);
            return (
              <li key={i} className={cn('flex gap-2', caveat ? 'text-warning' : 'text-muted-fg')}>
                {caveat ? <TriangleAlert className="mt-0.5 size-4 shrink-0" /> : <Info className="mt-0.5 size-4 shrink-0" />}
                <span>{n}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
