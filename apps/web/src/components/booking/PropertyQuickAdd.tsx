import { CLIENT_TYPES, PROPERTY_SERVICES, PropertySchema, type PropertyService } from '@carbooking/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, get, post, qs } from '@/lib/api';
import type { Client, Property } from '@/lib/types';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Field, Input, Segmented, Select } from '../ui/form';

const SERVICE_LABEL: Record<PropertyService, string> = { SALES: 'Sales', LETTINGS: 'Lettings', MANAGEMENT: 'Management' };

/** Add a property (and its client) on the spot while booking. The admin reviews it later. */
export function PropertyQuickAdd({
  open,
  onOpenChange,
  initial,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: { address: string; lat: number | null; lng: number | null };
  onCreated: (p: Property) => void;
}) {
  const [ref, setRef] = useState('');
  const [address, setAddress] = useState(initial.address);
  const [service, setService] = useState<PropertyService>('SALES');
  const [clientMode, setClientMode] = useState<'existing' | 'new'>('existing');
  const [clientQuery, setClientQuery] = useState('');
  const [clientId, setClientId] = useState('');
  const [newClient, setNewClient] = useState({ name: '', phone: '', type: 'VENDOR' as (typeof CLIENT_TYPES)[number] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clients = useQuery({
    queryKey: ['clients', clientQuery],
    queryFn: () => get<Client[]>(`/clients${qs({ q: clientQuery })}`),
    enabled: open && clientMode === 'existing',
  });

  const submit = async () => {
    const body = {
      ref,
      address,
      service,
      lat: initial.lat,
      lng: initial.lng,
      clientId: clientMode === 'existing' && clientId ? clientId : null,
      newClient: clientMode === 'new' && newClient.name ? { name: newClient.name, phone: newClient.phone || null, type: newClient.type } : undefined,
    };
    const parsed = PropertySchema.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the details');
      return;
    }
    setBusy(true);
    try {
      const p = await post<Property>('/properties', body);
      toast.success(`${p.ref} added. An admin will review it.`);
      onCreated(p);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a property"
      description="For a property not in the list yet. An admin will check it."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={submit}>
            Add property
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
          <Field label="Reference" required hint="Your listing reference">
            {(p) => <Input {...p} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="S-1050" />}
          </Field>
          <Field label="Address" required>
            {(p) => <Input {...p} value={address} onChange={(e) => setAddress(e.target.value)} />}
          </Field>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Service</span>
          <Segmented value={service} onChange={setService} options={PROPERTY_SERVICES.map((s) => ({ value: s, label: SERVICE_LABEL[s] }))} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Client</span>
            <Segmented
              value={clientMode}
              onChange={setClientMode}
              options={[
                { value: 'existing', label: 'Existing' },
                { value: 'new', label: 'New client' },
              ]}
            />
          </div>
          {clientMode === 'existing' ? (
            <div className="grid gap-2">
              <Input placeholder="Search clients" value={clientQuery} onChange={(e) => setClientQuery(e.target.value)} />
              <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">No client / not sure</option>
                {clients.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <Input className="sm:col-span-3" placeholder="Client name" value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} />
              <Input className="sm:col-span-2" placeholder="Phone (optional)" inputMode="tel" value={newClient.phone} onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })} />
              <Select value={newClient.type} onChange={(e) => setNewClient({ ...newClient, type: e.target.value as typeof newClient.type })}>
                <option value="VENDOR">Vendor</option>
                <option value="LANDLORD">Landlord</option>
                <option value="OTHER">Other</option>
              </Select>
            </div>
          )}
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
