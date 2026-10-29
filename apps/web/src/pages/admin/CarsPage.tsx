import { CAR_STATUSES, CarSchema, DriverSchema, FUEL_TYPES, type CarStatus, type FuelType } from '@carbooking/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Car as CarIcon, Pencil, Phone, Plus, UserRound } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { QueryBlock, TableSkeleton, UnitInput } from '@/components/admin/common';
import { check, numOrNull, numOrUndef, str, textOrNull, type FieldErrors } from '@/components/admin/form-utils';
import { CAR_STATUS, FUEL_TYPE_LABELS } from '@/components/admin/labels';
import { Page } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/form';
import { EmptyState, PageHeader, Table, Td, Th } from '@/components/ui/misc';
import { errorMessage, get, post, put } from '@/lib/api';
import type { Car, Driver } from '@/lib/types';

const CARS_KEY = ['admin', 'cars'] as const;
const DRIVERS_KEY = ['admin', 'drivers'] as const;

export function CarsPage() {
  const cars = useQuery({ queryKey: CARS_KEY, queryFn: () => get<Car[]>('/admin/cars') });
  const drivers = useQuery({ queryKey: DRIVERS_KEY, queryFn: () => get<Driver[]>('/admin/drivers') });
  const [carDialog, setCarDialog] = useState<{ car: Car | null } | null>(null);
  const [driverDialog, setDriverDialog] = useState<{ driver: Driver | null } | null>(null);

  return (
    <Page wide>
      <PageHeader
        title="Cars & driver"
        description="The cars staff can book, and the company driver who drives them."
        actions={
          <Button onClick={() => setCarDialog({ car: null })}>
            <Plus /> Add car
          </Button>
        }
      />

      <Card>
        <QueryBlock
          query={cars}
          empty={
            <EmptyState
              icon={<CarIcon />}
              title="No cars yet"
              description="Add the company cars so staff can book them."
              action={
                <Button onClick={() => setCarDialog({ car: null })}>
                  <Plus /> Add car
                </Button>
              }
            />
          }
        >
          {(list) => (
            <Table>
              <thead>
                <tr>
                  <Th>Registration</Th>
                  <Th>Make / model</Th>
                  <Th>Fuel</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Odometer</Th>
                  <Th className="w-0">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className={c.status === 'RETIRED' ? 'text-muted-fg' : undefined}>
                    <Td className="font-medium whitespace-nowrap">{c.registration}</Td>
                    <Td>
                      {c.make} {c.model}
                      {c.color && <span className="text-muted-fg"> · {c.color}</span>}
                    </Td>
                    <Td>{FUEL_TYPE_LABELS[c.fuelType]}</Td>
                    <Td>
                      <Badge tone={CAR_STATUS[c.status].tone}>{CAR_STATUS[c.status].label}</Badge>
                    </Td>
                    <Td className="tabular text-right whitespace-nowrap">{c.currentOdometer.toLocaleString('en-KE')} km</Td>
                    <Td>
                      <Button variant="ghost" size="icon-sm" onClick={() => setCarDialog({ car: c })} aria-label={`Edit ${c.registration}`}>
                        <Pencil />
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryBlock>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="Driver"
          description="The driver is a record, not a login: the app uses it to stop two trips that need the driver from overlapping."
          actions={
            <Button variant="secondary" size="sm" onClick={() => setDriverDialog({ driver: null })}>
              <Plus /> Add driver
            </Button>
          }
        />
        <QueryBlock
          query={drivers}
          skeleton={<TableSkeleton rows={1} />}
          empty={
            <EmptyState
              icon={<UserRound />}
              title="No driver set up"
              description="Staff can't book a trip until the driver is added."
              action={
                <Button onClick={() => setDriverDialog({ driver: null })}>
                  <Plus /> Add driver
                </Button>
              }
            />
          }
        >
          {(list) => (
            <ul className="divide-y divide-border">
              {list.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-fg">
                    <UserRound className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={d.active ? 'font-medium' : 'font-medium text-muted-fg'}>{d.name}</p>
                    <a href={`tel:${d.phone}`} className="tabular inline-flex items-center gap-1 text-sm text-muted-fg hover:text-fg">
                      <Phone className="size-3.5" /> {d.phone}
                    </a>
                  </div>
                  {d.active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}
                  <Button variant="ghost" size="icon-sm" onClick={() => setDriverDialog({ driver: d })} aria-label={`Edit ${d.name}`}>
                    <Pencil />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </QueryBlock>
      </Card>

      {carDialog && <CarDialog car={carDialog.car} onClose={() => setCarDialog(null)} />}
      {driverDialog && <DriverDialog driver={driverDialog.driver} onClose={() => setDriverDialog(null)} />}
    </Page>
  );
}

function CarDialog({ car, onClose }: { car: Car | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    registration: car?.registration ?? '',
    make: car?.make ?? '',
    model: car?.model ?? '',
    color: car?.color ?? '',
    seats: str(car?.seats),
    fuelType: (car?.fuelType ?? 'PETROL') as FuelType,
    status: (car?.status ?? 'AVAILABLE') as CarStatus,
    currentOdometer: str(car?.currentOdometer),
    notes: car?.notes ?? '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const save = useMutation({
    mutationFn: (body: unknown) => (car ? put<Car>(`/admin/cars/${car.id}`, body) : post<Car>('/admin/cars', body)),
    onSuccess: (saved) => {
      toast.success(car ? `${saved.registration} saved` : `${saved.registration} added`);
      void qc.invalidateQueries({ queryKey: CARS_KEY });
      void qc.invalidateQueries({ queryKey: ['reference'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit() {
    const r = check(CarSchema, {
      registration: f.registration,
      make: f.make,
      model: f.model,
      color: textOrNull(f.color),
      seats: numOrNull(f.seats),
      fuelType: f.fuelType,
      status: f.status,
      currentOdometer: numOrUndef(f.currentOdometer),
      notes: textOrNull(f.notes),
      homeOfficeId: car?.homeOfficeId ?? undefined,
    });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    save.mutate(r.data);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={car ? `Edit ${car.registration}` : 'Add a car'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            {car ? 'Save changes' : 'Add car'}
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
        <Field label="Registration" required error={errors.registration} hint="As on the number plate, e.g. KDA 123A">
          {(p) => <Input {...p} value={f.registration} onChange={(e) => set('registration', e.target.value)} autoCapitalize="characters" autoFocus />}
        </Field>
        <Field label="Fuel type" required error={errors.fuelType}>
          {(p) => (
            <Select {...p} value={f.fuelType} onChange={(e) => set('fuelType', e.target.value as FuelType)}>
              {FUEL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FUEL_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Make" required error={errors.make}>
          {(p) => <Input {...p} value={f.make} onChange={(e) => set('make', e.target.value)} placeholder="Toyota" />}
        </Field>
        <Field label="Model" required error={errors.model}>
          {(p) => <Input {...p} value={f.model} onChange={(e) => set('model', e.target.value)} placeholder="Axio" />}
        </Field>
        <Field label="Colour" error={errors.color}>
          {(p) => <Input {...p} value={f.color} onChange={(e) => set('color', e.target.value)} placeholder="Silver" />}
        </Field>
        <Field label="Seats" error={errors.seats}>
          {(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={20} value={f.seats} onChange={(e) => set('seats', e.target.value)} className="tabular" />}
        </Field>
        <Field label="Status" required error={errors.status} hint={f.status === 'MAINTENANCE' ? "Staff can't book it until it's available again." : f.status === 'RETIRED' ? 'Hidden from booking. Past trips are kept.' : undefined}>
          {(p) => (
            <Select {...p} value={f.status} onChange={(e) => set('status', e.target.value as CarStatus)}>
              {CAR_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {CAR_STATUS[s].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Current odometer"
          required
          error={errors.currentOdometer}
          hint={car ? 'The last recorded end reading. Trips update it; only correct it if it is wrong.' : 'The reading on the dashboard now.'}
        >
          {(p) => <UnitInput {...p} unit="km" type="number" inputMode="numeric" min={0} step={1} value={f.currentOdometer} onChange={(e) => set('currentOdometer', e.target.value)} />}
        </Field>
        <Field label="Notes" error={errors.notes} className="sm:col-span-2">
          {(p) => <Textarea {...p} value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} />}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function DriverDialog({ driver, onClose }: { driver: Driver | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(driver?.name ?? '');
  const [phone, setPhone] = useState(driver?.phone ?? '');
  const [active, setActive] = useState(driver?.active ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (body: unknown) => (driver ? put<Driver>(`/admin/drivers/${driver.id}`, body) : post<Driver>('/admin/drivers', body)),
    onSuccess: (saved) => {
      toast.success(driver ? `${saved.name} saved` : `${saved.name} added`);
      void qc.invalidateQueries({ queryKey: DRIVERS_KEY });
      void qc.invalidateQueries({ queryKey: ['reference'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit() {
    const r = check(DriverSchema, { name, phone, active });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    save.mutate(r.data);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={driver ? `Edit ${driver.name}` : 'Add the driver'}
      description="Staff see the driver's name and phone on their trip."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            {driver ? 'Save changes' : 'Add driver'}
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
        <Field label="Name" required error={errors.name}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <Field label="Phone" required error={errors.phone} hint="Kenyan numbers like 0712 345 678 or +254 712 345 678">
          {(p) => <Input {...p} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="tabular" />}
        </Field>
        <Switch checked={active} onChange={setActive} label="Active" description="Inactive drivers aren't assigned to new bookings." />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

