import { DEAL_TYPES, parseClosureRow, ResolveClosureRowSchema, type DealType } from '@carbooking/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Handshake, Inbox } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Callout, ConfirmDialog, dash, QueryBlock, SearchInput, UnitInput, useDebounced } from '@/components/admin/common';
import { check, numOrNull, type FieldErrors } from '@/components/admin/form-utils';
import { ImportCard } from '@/components/admin/ImportCard';
import { DEAL_TYPE_LABELS } from '@/components/admin/labels';
import { Page } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Label, Select } from '@/components/ui/form';
import { Dl, EmptyState, PageHeader, Spinner, Stat, Table, Tabs, TabsContent, TabsList, TabsTrigger, Td, Th } from '@/components/ui/misc';
import { errorMessage, get, post, postFile, qs } from '@/lib/api';
import { useFormat } from '@/lib/format';
import type { AdminUser, Closure, ClosureImportBatch, ClosureImportRow, Property } from '@/lib/types';
import { cn } from '@/lib/utils';

const REVIEW_KEY = ['admin', 'closures', 'review'] as const;
const LIST_KEY = ['admin', 'closures', 'list'] as const;
const BATCHES_KEY = ['admin', 'closures', 'batches'] as const;

/** 'property_crm_reference' → 'Property crm reference'. */
const humanize = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' ');

export function ClosuresPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('review');
  const review = useQuery({ queryKey: REVIEW_KEY, queryFn: () => get<ClosureImportRow[]>('/admin/closures/review') });
  const queueCount = review.data?.length ?? 0;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'closures'] });
    void qc.invalidateQueries({ queryKey: ['properties'] });
  };

  return (
    <Page wide>
      <PageHeader title="CRM closures" description="Sales and lettings closed in the CRM, set against what the viewings cost." />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Callout title="How closures get here" icon={<Handshake />}>
          Upload the closures export from the CRM, for example once a month. Each row is matched to a property by its <strong>CRM reference</strong> and to a staff
          member by <strong>email</strong>. A matched closure marks the property sold or let. Rows that don't match wait in the review queue below; rows already
          imported are skipped as duplicates.
        </Callout>

        <ImportCard<ClosureImportBatch>
          title="Upload closures export (CSV)"
          templatePath="/imports/templates/closures.csv"
          templateName="closures-template.csv"
          upload={(file) => postFile<ClosureImportBatch>('/admin/closures/import', file)}
          onSuccess={(b) => {
            toast.success(`${b.fileName}: ${b.matchedCount} matched`);
            refresh();
            if (b.unmatchedCount > 0) setTab('review');
          }}
          renderResult={(b) => (
            <div className="space-y-3">
              <p className="text-sm font-medium">{b.fileName}</p>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Rows" value={b.rowCount} />
                <Stat label="Matched" value={<span className="text-success">{b.matchedCount}</span>} />
                <Stat label="To review" value={<span className={b.unmatchedCount ? 'text-warning' : undefined}>{b.unmatchedCount}</span>} />
                <Stat label="Duplicates" value={b.duplicateCount} hint="Already imported" />
              </div>
            </div>
          )}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab} className="mt-6">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="review" className="inline-flex items-center gap-1.5">
            Review queue
            {queueCount > 0 && <span className="tabular rounded-full bg-warning px-1.5 text-[11px] leading-4 font-semibold text-white">{queueCount}</span>}
          </TabsTrigger>
          <TabsTrigger value="closures">Closures</TabsTrigger>
          <TabsTrigger value="imports">Imports</TabsTrigger>
        </TabsList>

        <TabsContent value="review" className="mt-4">
          <ReviewQueue query={review} onChanged={refresh} />
        </TabsContent>
        <TabsContent value="closures" className="mt-4">
          <ClosuresList />
        </TabsContent>
        <TabsContent value="imports" className="mt-4">
          <Imports />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

// ── Review queue ──────────────────────────────────────────────────────────────

function ReviewQueue({ query, onChanged }: { query: UseQueryResult<ClosureImportRow[]>; onChanged: () => void }) {
  const fmt = useFormat();
  const [resolving, setResolving] = useState<ClosureImportRow | null>(null);
  const [ignoring, setIgnoring] = useState<ClosureImportRow | null>(null);

  const ignore = useMutation({
    mutationFn: (id: string) => post(`/admin/closures/rows/${id}/resolve`, { ignore: true }),
    onSuccess: () => {
      toast.success('Row ignored');
      setIgnoring(null);
      onChanged();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card>
      <QueryBlock
        query={query}
        empty={<EmptyState icon={<CheckCircle2 />} title="Nothing to review" description="Every uploaded row has been matched, resolved or ignored." />}
      >
        {(rows) => (
          <ul className="divide-y divide-border">
            {rows.map((row) => {
              const fields = Object.entries(row.raw).filter(([, v]) => v != null && String(v).trim() !== '');
              return (
                <li key={row.id} className="space-y-3 px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">Row {row.rowNumber}</p>
                      <p className="flex items-center gap-1.5 text-xs text-muted-fg">
                        <FileSpreadsheet className="size-3.5" /> {row.batch.fileName} · uploaded {fmt.dateTime(row.batch.uploadedAt)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setIgnoring(row)}>
                        Ignore
                      </Button>
                      <Button size="sm" onClick={() => setResolving(row)}>
                        Resolve
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-lg bg-surface-2 p-3">
                      {fields.length ? (
                        <Dl className="text-xs" items={fields.map(([k, v]) => [humanize(k), <span className="font-mono break-all">{String(v)}</span>])} />
                      ) : (
                        <p className="text-xs text-muted-fg">The row is empty.</p>
                      )}
                    </div>
                    <ul className="space-y-1.5">
                      {row.problems.map((p, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-danger">
                          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </QueryBlock>

      {resolving && (
        <ResolveDialog
          row={resolving}
          onClose={() => setResolving(null)}
          onResolved={() => {
            setResolving(null);
            onChanged();
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(ignoring)}
        onOpenChange={(o) => !o && setIgnoring(null)}
        title="Ignore this row?"
        description="It won't become a closure and leaves the queue. Use this for rows that aren't real closures or that you've entered another way."
        confirmLabel="Ignore row"
        pending={ignore.isPending}
        onConfirm={() => ignoring && ignore.mutate(ignoring.id)}
      />
    </Card>
  );
}

const ResolveBody = ResolveClosureRowSchema.options[0];

function ResolveDialog({ row, onClose, onResolved }: { row: ClosureImportRow; onClose: () => void; onResolved: () => void }) {
  const fmt = useFormat();
  const parsed = useMemo(() => parseClosureRow(row.raw), [row.raw]);
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => get<AdminUser[]>('/admin/users') });

  const [search, setSearch] = useState(parsed.propertyCrmRef ?? '');
  const q = useDebounced(search.trim());
  const properties = useQuery({
    queryKey: ['properties', 'pick', q],
    queryFn: () => get<Property[]>(`/properties${qs({ q, limit: 20 })}`),
    placeholderData: keepPreviousData,
  });
  const [property, setProperty] = useState<Property | null>(null);

  const emailMatch = users.data?.find((u) => parsed.staffEmail && u.email.toLowerCase() === parsed.staffEmail)?.id;
  const [staffId, setStaffId] = useState<string | null>(null);
  const staff = staffId ?? emailMatch ?? '';

  const [closedAt, setClosedAt] = useState(parsed.closedAt ? parsed.closedAt.toISOString().slice(0, 10) : '');
  const [dealType, setDealType] = useState<DealType | ''>(parsed.dealType ?? '');
  const [fee, setFee] = useState(parsed.fee != null ? String(parsed.fee) : '');
  const [errors, setErrors] = useState<FieldErrors>({});

  const resolve = useMutation({
    mutationFn: (body: unknown) => post(`/admin/closures/rows/${row.id}/resolve`, body),
    onSuccess: () => {
      toast.success('Closure added');
      onResolved();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit() {
    const errs: FieldErrors = {};
    if (!property) errs.propertyId = 'Choose the property';
    if (!staff) errs.staffId = 'Choose who closed it';
    if (!closedAt) errs.closedAt = 'The CSV row has no readable date. Enter it.';
    if (!dealType) errs.dealType = 'The CSV row has no deal type. Choose one.';
    const r = check(ResolveBody, {
      propertyId: property?.id,
      staffId: staff || undefined,
      closedAt: closedAt || undefined,
      dealType: dealType || undefined,
      fee: numOrNull(fee),
    });
    if (!r.ok) Object.assign(errs, Object.fromEntries(Object.entries(r.errors).filter(([k]) => !(k in errs))));
    if (Object.keys(errs).length || !r.ok) return setErrors(errs);
    setErrors({});
    resolve.mutate(r.data);
  }

  const activeUsers = (users.data ?? []).filter((u) => u.active || u.id === staff);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Resolve row ${row.rowNumber}`}
      description="Pick the property and staff member this closure belongs to."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={resolve.isPending}>
            Add closure
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="rounded-lg bg-surface-2 p-3">
          <Dl
            className="text-xs"
            items={[
              ['Property CRM ref', parsed.propertyCrmRef ?? dash],
              ['Staff email', parsed.staffEmail ?? dash],
              ['Closed', parsed.closedAt ? fmt.date(parsed.closedAt) : dash],
              ['Deal', parsed.dealType ? DEAL_TYPE_LABELS[parsed.dealType] : dash],
              ['Fee', parsed.fee != null ? fmt.money(parsed.fee) : dash],
              ['CRM deal ref', parsed.dealRef ?? dash],
            ]}
          />
        </div>

        <div className="space-y-2">
          <Label>
            Property<span className="text-danger"> *</span>
          </Label>
          {property ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-primary bg-accent px-3 py-2">
              <div className="min-w-0 text-sm">
                <p className="font-medium text-accent-fg">
                  {property.ref}
                  {property.crmRef && <span className="font-normal text-muted-fg"> · CRM {property.crmRef}</span>}
                </p>
                <p className="truncate text-muted-fg">{property.address}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setProperty(null)}>
                Change
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <SearchInput value={search} onChange={setSearch} placeholder="Search ref, CRM ref, address or client" className="sm:w-full" />
                {properties.isFetching && <Spinner className="size-4" />}
              </div>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
                {properties.isPending ? (
                  <p className="p-3 text-sm text-muted-fg">Searching…</p>
                ) : properties.isError ? (
                  <p className="p-3 text-sm text-danger">{errorMessage(properties.error)}</p>
                ) : properties.data.length === 0 ? (
                  <p className="p-3 text-sm text-muted-fg">No property matches. Try part of the address or the client's name.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {properties.data.map((p) => (
                      <li key={p.id}>
                        <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => setProperty(p)}>
                          <span className="font-medium">{p.ref}</span>
                          {p.crmRef && <span className="text-muted-fg"> · CRM {p.crmRef}</span>}
                          <span className="block truncate text-muted-fg">
                            {p.address}
                            {p.client ? ` · ${p.client.name}` : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
          {errors.propertyId && <p className="text-xs text-danger">{errors.propertyId}</p>}
          {property && !property.crmRef && parsed.propertyCrmRef && (
            <p className="text-xs text-muted-fg">Tip: set this property's CRM reference to {parsed.propertyCrmRef} so future uploads match it automatically.</p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Closed by" required error={errors.staffId} className="sm:col-span-2" hint={emailMatch && !staffId ? 'Matched by email' : undefined}>
            {(p) => (
              <Select {...p} value={staff} onChange={(e) => setStaffId(e.target.value)} disabled={users.isPending}>
                <option value="">{users.isPending ? 'Loading…' : 'Choose a staff member'}</option>
                {activeUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Closing date" required={!parsed.closedAt} error={errors.closedAt} hint={parsed.closedAt ? 'From the CSV; change it if wrong' : undefined}>
            {(p) => <Input {...p} type="date" value={closedAt} onChange={(e) => setClosedAt(e.target.value)} />}
          </Field>
          <Field label="Deal type" required={!parsed.dealType} error={errors.dealType}>
            {(p) => (
              <Select {...p} value={dealType} onChange={(e) => setDealType(e.target.value as DealType | '')}>
                <option value="">Choose…</option>
                {DEAL_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {DEAL_TYPE_LABELS[d]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Fee" error={errors.fee} hint="Optional" className="sm:col-span-2">
            {(p) => <UnitInput {...p} unit={fmt.currency} unitPosition="start" type="number" min={0} step="any" value={fee} onChange={(e) => setFee(e.target.value)} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

// ── Closures and imports ──────────────────────────────────────────────────────

function ClosuresList() {
  const fmt = useFormat();
  const closures = useQuery({ queryKey: LIST_KEY, queryFn: () => get<Closure[]>('/admin/closures') });
  return (
    <Card>
      <QueryBlock query={closures} empty={<EmptyState icon={<Handshake />} title="No closures yet" description="Upload the CRM's closures export to see them here." />}>
        {(rows) => {
          const totalFees = rows.reduce((s, c) => s + (c.fee ?? 0), 0);
          return (
            <>
              <div className="flex flex-wrap gap-x-8 gap-y-3 border-b border-border px-5 py-4">
                <Stat label="Closures" value={rows.length} />
                <Stat label="Sales" value={rows.filter((c) => c.dealType === 'SALE').length} />
                <Stat label="Lettings" value={rows.filter((c) => c.dealType === 'LETTING').length} />
                <Stat label="Fees" value={fmt.money(totalFees)} />
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>Closed</Th>
                    <Th>Property</Th>
                    <Th>Staff</Th>
                    <Th>Deal</Th>
                    <Th className="text-right">Fee</Th>
                    <Th>CRM deal ref</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <Td className="whitespace-nowrap">{fmt.date(c.closedAt)}</Td>
                      <Td className="min-w-56">
                        <span className="font-medium">{c.property.ref}</span>
                        <span className="block text-xs text-muted-fg">{c.property.address}</span>
                      </Td>
                      <Td className="whitespace-nowrap">{c.staff?.name ?? dash}</Td>
                      <Td>
                        <Badge tone={c.dealType === 'SALE' ? 'info' : 'primary'}>{DEAL_TYPE_LABELS[c.dealType]}</Badge>
                      </Td>
                      <Td className="tabular text-right whitespace-nowrap">{c.fee != null ? fmt.money(c.fee) : dash}</Td>
                      <Td className="whitespace-nowrap">{c.crmRef ?? dash}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          );
        }}
      </QueryBlock>
    </Card>
  );
}

function Imports() {
  const fmt = useFormat();
  const batches = useQuery({ queryKey: BATCHES_KEY, queryFn: () => get<ClosureImportBatch[]>('/admin/closures/batches') });
  return (
    <Card>
      <QueryBlock query={batches} empty={<EmptyState icon={<Inbox />} title="No uploads yet" description="Each CSV you upload is listed here with how many rows matched." />}>
        {(rows) => (
          <Table>
            <thead>
              <tr>
                <Th>File</Th>
                <Th>Uploaded</Th>
                <Th>By</Th>
                <Th className="text-right">Rows</Th>
                <Th className="text-right">Matched</Th>
                <Th className="text-right">Unmatched</Th>
                <Th className="text-right">Duplicates</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <Td className="font-medium">{b.fileName}</Td>
                  <Td className="whitespace-nowrap">{fmt.dateTime(b.uploadedAt)}</Td>
                  <Td className="whitespace-nowrap">{b.uploadedBy?.name ?? dash}</Td>
                  <Td className="tabular text-right">{b.rowCount}</Td>
                  <Td className="tabular text-right text-success">{b.matchedCount}</Td>
                  <Td className={cn('tabular text-right', b.unmatchedCount > 0 && 'text-warning')}>{b.unmatchedCount}</Td>
                  <Td className="tabular text-right text-muted-fg">{b.duplicateCount}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryBlock>
    </Card>
  );
}
