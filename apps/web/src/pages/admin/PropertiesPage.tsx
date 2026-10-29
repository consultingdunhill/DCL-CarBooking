import { CLIENT_TYPES, CRM_PROPERTY_PREFIX, PROPERTY_SERVICES, PROPERTY_STATUSES, PropertySchema, type ClientType, type LatLng, type PropertyService, type PropertyStatus } from '@carbooking/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, MapPin, Pencil, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Callout, dash, QueryBlock, SearchInput, useDebounced } from '@/components/admin/common';
import { check, textOrNull, type FieldErrors } from '@/components/admin/form-utils';
import { ImportCard } from '@/components/admin/ImportCard';
import { CLIENT_TYPE_LABELS, NAIROBI, PROPERTY_STATUS, SERVICE_LABELS } from '@/components/admin/labels';
import { MapPicker } from '@/components/admin/MapPicker';
import { Page } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Label, Segmented, Select } from '@/components/ui/form';
import { EmptyState, PageHeader, Spinner, Stat, Table, Td, Th } from '@/components/ui/misc';
import { errorMessage, get, post, postFile, put, qs } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useReference } from '@/lib/queries';
import type { Client, Property } from '@/lib/types';
import { cn } from '@/lib/utils';

const LIMIT = 200;

interface CrmSyncSummary {
  listings: number;
  created: number;
  updated: number;
  unchanged: number;
  withdrawn: number;
  errors: { ref: string; error: string }[];
}

interface PortfolioImportSummary {
  fileName: string;
  rows: number;
  created: number;
  updated: number;
  clientsCreated: number;
  errors: { row: number; error: string }[];
  errorCount: number;
}

const listKey = (q: string, review: boolean) => ['properties', 'list', { q, review }] as const;
const fetchList = (q: string, review: boolean) => get<Property[]>(`/properties${qs({ q, review: review ? 1 : undefined, limit: review ? 500 : LIMIT })}`);

export function PropertiesPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const review = params.get('review') === '1';
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [dialog, setDialog] = useState<{ property: Property | null } | null>(null);

  const list = useQuery({ queryKey: listKey(q, review), queryFn: () => fetchList(q, review), placeholderData: keepPreviousData });
  // Count of properties waiting for review (shared cache with the filtered list).
  const toReview = useQuery({ queryKey: listKey('', true), queryFn: () => fetchList('', true) });
  const reviewCount = toReview.data?.length ?? 0;

  const setReview = (on: boolean) => setParams(on ? { review: '1' } : {}, { replace: true });

  return (
    <Page wide>
      <PageHeader
        title="Properties"
        description="The portfolio staff visit. Each stop links to a property, and each property to its client, so costs add up per property and client."
        actions={
          <Button onClick={() => setDialog({ property: null })}>
            <Plus /> Add property
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search ref, CRM ref, address or client" className="sm:w-96" />
        <Segmented<'all' | 'review'>
          value={review ? 'review' : 'all'}
          onChange={(v) => setReview(v === 'review')}
          options={[
            { value: 'all', label: 'All' },
            {
              value: 'review',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Needs review
                  {reviewCount > 0 && <span className="tabular rounded-full bg-warning px-1.5 text-[11px] leading-4 font-semibold text-white">{reviewCount}</span>}
                </span>
              ),
            },
          ]}
        />
        {list.isFetching && !list.isPending && <Spinner className="size-4" />}
      </div>

      {review && (
        <Callout className="mb-4" tone="warning">
          Staff added these while booking. Check the details, set the location and client, then save to mark them reviewed.
        </Callout>
      )}

      <Card>
        <QueryBlock
          query={list}
          empty={
            q ? (
              <EmptyState title="No matches" description={`No property matches “${q}”.`} />
            ) : review ? (
              <EmptyState icon={<Building2 />} title="Nothing to review" description="New properties added by staff will appear here." />
            ) : (
              <EmptyState
                icon={<Building2 />}
                title="No properties yet"
                description="Import the portfolio from a CSV below, or add properties one by one."
                action={
                  <Button onClick={() => setDialog({ property: null })}>
                    <Plus /> Add property
                  </Button>
                }
              />
            )
          }
        >
          {(rows) => (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>Ref</Th>
                    <Th>Address</Th>
                    <Th>Client</Th>
                    <Th>Service</Th>
                    <Th>Status</Th>
                    <Th>CRM ref</Th>
                    {review && <Th>Added by</Th>}
                    <Th className="w-0">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className={cn(p.needsReview && !review && 'bg-warning-bg/40')}>
                      <Td className="font-medium whitespace-nowrap">
                        {p.ref}
                        {p.needsReview && !review && (
                          <Badge tone="warning" className="ml-2">
                            Review
                          </Badge>
                        )}
                      </Td>
                      <Td className="min-w-56">
                        <span className="inline-flex items-start gap-1.5">
                          <MapPin className={cn('mt-0.5 size-3.5 shrink-0', p.lat != null ? 'text-primary' : 'text-muted-fg/40')} aria-label={p.lat != null ? 'Location set' : 'No location'} />
                          {p.address}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap">{p.client?.name ?? dash}</Td>
                      <Td>{SERVICE_LABELS[p.service]}</Td>
                      <Td>
                        <Badge tone={PROPERTY_STATUS[p.status].tone}>{PROPERTY_STATUS[p.status].label}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap">{p.crmRef ?? dash}</Td>
                      {review && <Td className="whitespace-nowrap">{p.createdBy?.name ?? dash}</Td>}
                      <Td>
                        <Button variant={p.needsReview ? 'secondary' : 'ghost'} size={p.needsReview ? 'sm' : 'icon-sm'} onClick={() => setDialog({ property: p })} aria-label={`Edit ${p.ref}`}>
                          {p.needsReview ? 'Review' : <Pencil />}
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {rows.length >= LIMIT && !review && <p className="px-4 py-3 text-sm text-muted-fg">Showing the first {LIMIT}. Search to find others.</p>}
            </>
          )}
        </QueryBlock>
      </Card>

      <CrmSyncCard />

      <div className="mt-6">
        <ImportCard<PortfolioImportSummary>
          title="Import portfolio (CSV)"
          description="Adds new properties and updates existing ones by reference. Clients are matched by CRM reference or name, and created if missing."
          templatePath="/imports/templates/portfolio.csv"
          templateName="portfolio-template.csv"
          upload={(file) => postFile<PortfolioImportSummary>('/properties/import', file)}
          onSuccess={(r) => {
            toast.success(`Imported ${r.fileName}: ${r.created} added, ${r.updated} updated`);
            void qc.invalidateQueries({ queryKey: ['properties'] });
            void qc.invalidateQueries({ queryKey: ['clients'] });
          }}
          renderResult={(r) => <ImportSummary result={r} />}
        />
      </div>

      {dialog && <PropertyDialog property={dialog.property} onClose={() => setDialog(null)} />}
    </Page>
  );
}

/** The CRM's website listings, synced nightly; hidden when the link isn't set up. */
function CrmSyncCard() {
  const qc = useQueryClient();
  const fmt = useFormat();
  const last = useQuery({ queryKey: ['crm', 'last-sync'], queryFn: () => get<{ enabled: boolean; at: string | null; summary: CrmSyncSummary | null }>('/admin/crm/last-sync') });
  const sync = useMutation({
    mutationFn: () => post<CrmSyncSummary>('/admin/crm/sync'),
    onSuccess: (r) => {
      toast.success(`Synced ${r.listings} CRM listings: ${r.created} added, ${r.updated} updated, ${r.withdrawn} withdrawn`);
      void qc.invalidateQueries({ queryKey: ['properties'] });
      void qc.invalidateQueries({ queryKey: ['crm', 'last-sync'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (!last.data?.enabled) return null;
  const s = last.data.summary;
  return (
    <Card className="mt-6">
      <CardHeader
        title="Listings from the CRM"
        description="The website listings in the CRM, synced every night at 04:00. The CRM decides whether each is for sale, to let, sold or withdrawn, and where it is; the address and client are yours to edit here."
        actions={
          <Button variant="secondary" onClick={() => sync.mutate()} loading={sync.isPending}>
            <RefreshCw /> Sync now
          </Button>
        }
      />
      <CardBody className="text-sm text-muted-fg">
        {last.data.at && s ? (
          <>
            Last synced {fmt.relative(last.data.at)}: {s.listings} listings, {s.created} added, {s.updated} updated, {s.withdrawn} withdrawn.
            {s.errors.length > 0 && <span className="text-danger"> {s.errors.length} could not be synced: {s.errors.map((e) => `${e.ref} (${e.error})`).join('; ')}.</span>}
          </>
        ) : (
          'Not synced yet.'
        )}{' '}
        Agents pin each listing's exact location in the CRM; until they do, staff place it on the map each time they book it.
      </CardBody>
    </Card>
  );
}

function ImportSummary({ result: r }: { result: PortfolioImportSummary }) {
  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{r.fileName}</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Rows" value={r.rows} />
        <Stat label="Added" value={r.created} />
        <Stat label="Updated" value={r.updated} />
        <Stat label="New clients" value={r.clientsCreated} />
        <Stat label="Errors" value={<span className={r.errorCount ? 'text-danger' : undefined}>{r.errorCount}</span>} />
      </div>
      {r.errors.length > 0 && (
        <div>
          <p className="mb-1.5 text-sm font-medium">Rows that weren't imported</p>
          <ul className="space-y-1 text-sm">
            {r.errors.slice(0, 10).map((e) => (
              <li key={e.row} className="flex gap-2">
                <span className="tabular w-16 shrink-0 text-muted-fg">Row {e.row}</span>
                <span className="text-danger">{e.error}</span>
              </li>
            ))}
          </ul>
          {r.errorCount > 10 && <p className="mt-1.5 text-sm text-muted-fg">…and {r.errorCount - 10} more. Fix them in the file and upload it again; rows already imported are updated, not duplicated.</p>}
        </div>
      )}
    </div>
  );
}

type PropertyInput = z.output<typeof PropertySchema>;
const NEW_CLIENT = '__new';

function PropertyDialog({ property, onClose }: { property: Property | null; onClose: () => void }) {
  const qc = useQueryClient();
  const office = useReference().data?.office;
  const clients = useQuery({ queryKey: ['clients', ''], queryFn: () => get<Client[]>('/clients') });

  const [f, setF] = useState({
    ref: property?.ref ?? '',
    crmRef: property?.crmRef ?? '',
    address: property?.address ?? '',
    service: (property?.service ?? 'SALES') as PropertyService,
    status: (property?.status ?? 'ACTIVE') as PropertyStatus,
    clientId: property?.clientId ?? '',
  });
  const [nc, setNc] = useState({ name: '', type: 'VENDOR' as ClientType, phone: '', email: '', crmRef: '' });
  const [location, setLocation] = useState<LatLng | null>(property?.lat != null && property.lng != null ? { lat: property.lat, lng: property.lng } : null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const isNewClient = f.clientId === NEW_CLIENT;

  const clientOptions = [...(clients.data ?? [])];
  if (property?.client && !clientOptions.some((c) => c.id === property.client!.id)) {
    clientOptions.unshift({ id: property.client.id, name: property.client.name, type: property.client.type ?? 'OTHER', phone: null, email: null, crmRef: null });
  }

  const save = useMutation({
    mutationFn: async (body: PropertyInput) => {
      if (!property) return post<Property>('/properties', body);
      // Editing doesn't create clients on the server, so add the new client first.
      let clientId = body.clientId ?? null;
      if (body.newClient) clientId = (await post<Client>('/clients', body.newClient)).id;
      return put<Property>(`/properties/${property.id}`, { ...body, newClient: undefined, clientId });
    },
    onSuccess: (saved) => {
      toast.success(property?.needsReview ? `${saved.ref} reviewed and saved` : property ? `${saved.ref} saved` : `${saved.ref} added`);
      void qc.invalidateQueries({ queryKey: ['properties'] });
      void qc.invalidateQueries({ queryKey: ['clients'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit() {
    const r = check(PropertySchema, {
      ref: f.ref,
      crmRef: textOrNull(f.crmRef),
      address: f.address,
      service: f.service,
      status: f.status,
      lat: location?.lat ?? null,
      lng: location?.lng ?? null,
      clientId: isNewClient || !f.clientId ? null : f.clientId,
      newClient: isNewClient ? { name: nc.name, type: nc.type, phone: nc.phone, email: nc.email.trim(), crmRef: textOrNull(nc.crmRef) } : undefined,
    });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    save.mutate(r.data);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={property ? (property.needsReview ? `Review ${property.ref}` : `Edit ${property.ref}`) : 'Add a property'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            {property?.needsReview ? 'Save and mark reviewed' : property ? 'Save changes' : 'Add property'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {property?.needsReview && <Callout tone="warning">Added by {property.createdBy?.name ?? 'a staff member'} while booking. Saving marks it as reviewed.</Callout>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reference" required error={errors.ref} hint="Your internal property reference">
            {(p) => <Input {...p} value={f.ref} onChange={(e) => set('ref', e.target.value)} autoFocus={!property} />}
          </Field>
          <Field label="CRM reference" error={errors.crmRef} hint="Used to match closures from the CRM">
            {(p) => <Input {...p} value={f.crmRef} onChange={(e) => set('crmRef', e.target.value)} />}
          </Field>
          <Field label="Address" required error={errors.address} className="sm:col-span-2">
            {(p) => <Input {...p} value={f.address} onChange={(e) => set('address', e.target.value)} placeholder="e.g. Flat 12, Gitanga Road, Kileleshwa" />}
          </Field>
          <Field label="Service" required error={errors.service}>
            {(p) => (
              <Select {...p} value={f.service} onChange={(e) => set('service', e.target.value as PropertyService)}>
                {PROPERTY_SERVICES.map((s) => (
                  <option key={s} value={s}>
                    {SERVICE_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Status" required error={errors.status} hint="Closures from the CRM set this to sold or let.">
            {(p) => (
              <Select {...p} value={f.status} onChange={(e) => set('status', e.target.value as PropertyStatus)}>
                {PROPERTY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {PROPERTY_STATUS[s].label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Client" error={errors.clientId} className="sm:col-span-2">
            {(p) => (
              <Select
                {...p}
                value={f.clientId}
                onChange={(e) => {
                  set('clientId', e.target.value);
                  if (e.target.value === NEW_CLIENT) setNc((c) => ({ ...c, type: f.service === 'SALES' ? 'VENDOR' : 'LANDLORD' }));
                }}
                disabled={clients.isPending}
              >
                <option value="">{clients.isPending ? 'Loading clients…' : 'No client'}</option>
                {clientOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.crmRef ? ` (${c.crmRef})` : ''}
                  </option>
                ))}
                <option value={NEW_CLIENT}>+ Add a new client…</option>
              </Select>
            )}
          </Field>
        </div>

        {isNewClient && (
          <fieldset className="grid gap-4 rounded-xl border border-border bg-surface-2 p-4 sm:grid-cols-2">
            <legend className="px-1 text-sm font-medium">New client</legend>
            <Field label="Name" required error={errors['newClient.name']}>
              {(p) => <Input {...p} value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} />}
            </Field>
            <Field label="Type" required error={errors['newClient.type']}>
              {(p) => (
                <Select {...p} value={nc.type} onChange={(e) => setNc({ ...nc, type: e.target.value as ClientType })}>
                  {CLIENT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {CLIENT_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Phone" error={errors['newClient.phone']}>
              {(p) => <Input {...p} type="tel" inputMode="tel" value={nc.phone} onChange={(e) => setNc({ ...nc, phone: e.target.value })} />}
            </Field>
            <Field label="Email" error={errors['newClient.email']}>
              {(p) => <Input {...p} type="email" value={nc.email} onChange={(e) => setNc({ ...nc, email: e.target.value })} />}
            </Field>
            <Field label="CRM reference" error={errors['newClient.crmRef']} className="sm:col-span-2">
              {(p) => <Input {...p} value={nc.crmRef} onChange={(e) => setNc({ ...nc, crmRef: e.target.value })} />}
            </Field>
          </fieldset>
        )}

        {property?.crmRef?.startsWith(CRM_PROPERTY_PREFIX) ? (
          <div className="space-y-1.5">
            <Label>Location</Label>
            <p className="text-sm text-muted-fg">
              {location ? <span className="tabular">{location.lat.toFixed(5)}, {location.lng.toFixed(5)}. </span> : 'Not pinned yet. '}
              This is a CRM listing, so agents pin its exact location in the CRM, on the listing's location page. It is copied here every night and whenever someone books it.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-end justify-between gap-2">
              <Label>Location</Label>
              {location ? (
                <span className="flex items-center gap-2 text-xs text-muted-fg">
                  <span className="tabular">
                    {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
                  </span>
                  <Button type="button" variant="link" size="sm" className="text-xs" onClick={() => setLocation(null)}>
                    Clear
                  </Button>
                </span>
              ) : (
                <span className="text-xs text-muted-fg">Optional</span>
              )}
            </div>
            <MapPicker value={location} onChange={setLocation} center={office ? { lat: office.lat, lng: office.lng } : NAIROBI} title={f.ref || 'Property'} />
            <p className="text-xs text-muted-fg">{location ? 'Click elsewhere to move the pin.' : 'Click the map to drop a pin. Used to suggest this property when staff pick a stop nearby.'}</p>
            {(errors.lat || errors.lng) && <p className="text-xs text-danger">{errors.lat ?? errors.lng}</p>}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
