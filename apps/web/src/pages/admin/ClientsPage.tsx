import { CLIENT_TYPES, ClientSchema, type ClientType } from '@carbooking/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Contact, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { dash, QueryBlock, SearchInput, useDebounced } from '@/components/admin/common';
import { check, textOrNull, type FieldErrors } from '@/components/admin/form-utils';
import { CLIENT_TYPE_LABELS } from '@/components/admin/labels';
import { Page } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { EmptyState, PageHeader, Spinner, Table, Td, Th } from '@/components/ui/misc';
import { errorMessage, get, post, put, qs } from '@/lib/api';
import type { Client } from '@/lib/types';

export function ClientsPage() {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [dialog, setDialog] = useState<{ client: Client | null } | null>(null);
  const clients = useQuery({ queryKey: ['clients', q], queryFn: () => get<Client[]>(`/clients${qs({ q })}`), placeholderData: keepPreviousData });

  return (
    <Page wide>
      <PageHeader
        title="Clients"
        description="Vendors and landlords whose properties you market or manage. Reports total visit costs per client."
        actions={
          <Button onClick={() => setDialog({ client: null })}>
            <Plus /> Add client
          </Button>
        }
      />
      <div className="mb-4 flex items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search name or CRM ref" />
        {clients.isFetching && !clients.isPending && <Spinner className="size-4" />}
      </div>

      <Card>
        <QueryBlock
          query={clients}
          empty={
            q ? (
              <EmptyState title="No matches" description={`No client matches “${q}”.`} />
            ) : (
              <EmptyState
                icon={<Contact />}
                title="No clients yet"
                description={
                  <>
                    Clients are created when you{' '}
                    <Link to="/admin/properties" className="text-primary hover:underline">
                      import the portfolio
                    </Link>
                    , or you can add them here.
                  </>
                }
                action={
                  <Button onClick={() => setDialog({ client: null })}>
                    <Plus /> Add client
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
                    <Th>Name</Th>
                    <Th>Type</Th>
                    <Th>Phone</Th>
                    <Th>Email</Th>
                    <Th>CRM ref</Th>
                    <Th className="text-right">Properties</Th>
                    <Th className="w-0">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <Td className="font-medium">{c.name}</Td>
                      <Td>
                        <Badge>{CLIENT_TYPE_LABELS[c.type]}</Badge>
                      </Td>
                      <Td className="tabular whitespace-nowrap">{c.phone ? <a href={`tel:${c.phone}`} className="hover:underline">{c.phone}</a> : dash}</Td>
                      <Td className="whitespace-nowrap">{c.email ? <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a> : dash}</Td>
                      <Td className="whitespace-nowrap">{c.crmRef ?? dash}</Td>
                      <Td className="tabular text-right">{c._count?.properties ?? 0}</Td>
                      <Td>
                        <Button variant="ghost" size="icon-sm" onClick={() => setDialog({ client: c })} aria-label={`Edit ${c.name}`}>
                          <Pencil />
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {rows.length >= 200 && <p className="px-4 py-3 text-sm text-muted-fg">Showing the first 200. Search to find others.</p>}
            </>
          )}
        </QueryBlock>
      </Card>

      {dialog && <ClientDialog client={dialog.client} onClose={() => setDialog(null)} />}
    </Page>
  );
}

function ClientDialog({ client, onClose }: { client: Client | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: client?.name ?? '',
    type: (client?.type ?? 'VENDOR') as ClientType,
    phone: client?.phone ?? '',
    email: client?.email ?? '',
    crmRef: client?.crmRef ?? '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const save = useMutation({
    mutationFn: (body: unknown) => (client ? put<Client>(`/clients/${client.id}`, body) : post<Client>('/clients', body)),
    onSuccess: (saved) => {
      toast.success(client ? `${saved.name} saved` : `${saved.name} added`);
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void qc.invalidateQueries({ queryKey: ['properties'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit() {
    const r = check(ClientSchema, { name: f.name, type: f.type, phone: f.phone.trim(), email: f.email.trim(), crmRef: textOrNull(f.crmRef) });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    save.mutate(r.data);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={client ? `Edit ${client.name}` : 'Add a client'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            {client ? 'Save changes' : 'Add client'}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" required error={errors.name} className="sm:col-span-2">
          {(p) => <Input {...p} value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />}
        </Field>
        <Field label="Type" required error={errors.type}>
          {(p) => (
            <Select {...p} value={f.type} onChange={(e) => set('type', e.target.value as ClientType)}>
              {CLIENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CLIENT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="CRM reference" error={errors.crmRef}>
          {(p) => <Input {...p} value={f.crmRef} onChange={(e) => set('crmRef', e.target.value)} />}
        </Field>
        <Field label="Phone" error={errors.phone}>
          {(p) => <Input {...p} type="tel" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} className="tabular" />}
        </Field>
        <Field label="Email" error={errors.email}>
          {(p) => <Input {...p} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
