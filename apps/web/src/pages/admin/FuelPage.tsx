import { addMonths, FuelEntrySchema, monthKey, monthStart, type FuelEntryType } from '@carbooking/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fuel, Paperclip, Pencil, Plus, Receipt, Trash2, X } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog, dash, QueryBlock, UnitInput } from '@/components/admin/common';
import { check, numOrNull, numOrUndef, str, textOrNull, type FieldErrors } from '@/components/admin/form-utils';
import { FUEL_ENTRY_TYPE_LABELS } from '@/components/admin/labels';
import { Page } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Label, Segmented, Select, Textarea } from '@/components/ui/form';
import { EmptyState, PageHeader, Spinner, Table, Td, Th } from '@/components/ui/misc';
import { del, errorMessage, get, post, put, qs, uploadFile } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useReference } from '@/lib/queries';
import type { FuelEntry } from '@/lib/types';

const KEY = ['admin', 'fuel'] as const;
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const MAX_RECEIPT = 15 * 1024 * 1024;

const litresText = (n: number) => `${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })} L`;

/** 'YYYY-MM' → 'Oct 2026'. */
function monthLabel(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Open a signed receipt URL in a new tab (opened first so pop-up blockers allow it). */
async function openReceipt(id: string) {
  const w = window.open('', '_blank');
  try {
    const { url } = await get<{ url: string }>(`/admin/fuel/${id}/receipt`);
    if (w) {
      w.opener = null;
      w.location.href = url;
    } else window.location.assign(url);
  } catch (err) {
    w?.close();
    toast.error(errorMessage(err));
  }
}

export function FuelPage() {
  const fmt = useFormat();
  const qc = useQueryClient();
  const cars = useReference().data?.cars ?? [];
  const thisMonth = monthKey(new Date(), fmt.tz);
  const [carId, setCarId] = useState('');
  const [month, setMonth] = useState(thisMonth);
  const [dialog, setDialog] = useState<{ entry: FuelEntry | null } | null>(null);
  const [deleting, setDeleting] = useState<FuelEntry | null>(null);

  const range = month ? { from: monthStart(month, fmt.tz).toISOString(), to: monthStart(addMonths(month, 1), fmt.tz).toISOString() } : {};
  const entries = useQuery({
    queryKey: [...KEY, { carId, month, tz: fmt.tz }],
    queryFn: () => get<FuelEntry[]>(`/admin/fuel${qs({ carId, ...range })}`),
    placeholderData: keepPreviousData,
  });

  const summary = useMemo(() => {
    const by = new Map<string, { carId: string; registration: string; litres: number; amount: number; count: number }>();
    for (const e of entries.data ?? []) {
      const s = by.get(e.carId) ?? { carId: e.carId, registration: e.car?.registration ?? cars.find((c) => c.id === e.carId)?.registration ?? 'Car', litres: 0, amount: 0, count: 0 };
      s.litres += e.litres;
      s.amount += e.amount;
      s.count += 1;
      by.set(e.carId, s);
    }
    return [...by.values()].sort((a, b) => a.registration.localeCompare(b.registration));
  }, [entries.data, cars]);
  const totals = summary.reduce((t, s) => ({ litres: t.litres + s.litres, amount: t.amount + s.amount, count: t.count + s.count }), { litres: 0, amount: 0, count: 0 });
  const perLitre = (amount: number, litres: number) =>
    litres > 0 ? `${fmt.currency} ${(amount / litres).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '–';

  const remove = useMutation({
    mutationFn: (id: string) => del(`/admin/fuel/${id}`),
    onSuccess: () => {
      toast.success('Fuel entry deleted');
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const periodLabel = month ? monthLabel(month) : 'all time';

  return (
    <Page wide>
      <PageHeader
        title="Fuel entries"
        description="Fill-ups and monthly fuel totals per car. Litres are needed to work out km per litre and cost per km."
        actions={
          <Button onClick={() => setDialog({ entry: null })}>
            <Plus /> Add fuel
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-56">
          <Label htmlFor="fuel-car">Car</Label>
          <Select id="fuel-car" value={carId} onChange={(e) => setCarId(e.target.value)}>
            <option value="">All cars</option>
            {cars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.registration} · {c.make} {c.model}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fuel-month">Month</Label>
          <div className="flex items-center gap-2">
            <Input id="fuel-month" type="month" value={month} max={thisMonth} onChange={(e) => setMonth(e.target.value)} className="tabular w-44" />
            {month ? (
              <Button variant="ghost" size="sm" onClick={() => setMonth('')}>
                All time
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setMonth(thisMonth)}>
                This month
              </Button>
            )}
          </div>
        </div>
        {entries.isFetching && !entries.isPending && <Spinner className="mb-2.5 size-4" />}
      </div>

      {summary.length > 0 && (
        <Card className="mb-6">
          <CardHeader title={`Summary · ${periodLabel}`} description={!month ? 'Latest 500 entries.' : undefined} />
          <Table>
            <thead>
              <tr>
                <Th>Car</Th>
                <Th className="text-right">Entries</Th>
                <Th className="text-right">Litres</Th>
                <Th className="text-right">Amount</Th>
                <Th className="text-right">Per litre</Th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.carId}>
                  <Td className="font-medium">{s.registration}</Td>
                  <Td className="tabular text-right">{s.count}</Td>
                  <Td className="tabular text-right">{litresText(s.litres)}</Td>
                  <Td className="tabular text-right">{fmt.money(s.amount)}</Td>
                  <Td className="tabular text-right">{perLitre(s.amount, s.litres)}</Td>
                </tr>
              ))}
              {summary.length > 1 && (
                <tr className="font-semibold">
                  <Td>Total</Td>
                  <Td className="tabular text-right">{totals.count}</Td>
                  <Td className="tabular text-right">{litresText(totals.litres)}</Td>
                  <Td className="tabular text-right">{fmt.money(totals.amount)}</Td>
                  <Td className="tabular text-right">{perLitre(totals.amount, totals.litres)}</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}

      <Card>
        <QueryBlock
          query={entries}
          empty={
            <EmptyState
              icon={<Fuel />}
              title={month ? `No fuel entries for ${periodLabel}` : 'No fuel entries yet'}
              description="Add each fill-up, or one monthly total per car, with litres and amount."
              action={
                <Button onClick={() => setDialog({ entry: null })}>
                  <Plus /> Add fuel
                </Button>
              }
            />
          }
        >
          {(rows) => (
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Car</Th>
                  <Th>Type</Th>
                  <Th className="text-right">Litres</Th>
                  <Th className="text-right">Amount</Th>
                  <Th className="text-right">Per litre</Th>
                  <Th className="text-right">Odometer</Th>
                  <Th>Receipt</Th>
                  <Th>Entered by</Th>
                  <Th className="w-0">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap">{e.type === 'MONTHLY' ? monthLabel(fmt.dateKey(e.date).slice(0, 7)) : fmt.date(e.date)}</Td>
                    <Td className="font-medium whitespace-nowrap">{e.car?.registration ?? dash}</Td>
                    <Td>
                      <Badge tone={e.type === 'MONTHLY' ? 'info' : 'neutral'}>{FUEL_ENTRY_TYPE_LABELS[e.type]}</Badge>
                    </Td>
                    <Td className="tabular text-right whitespace-nowrap">{litresText(e.litres)}</Td>
                    <Td className="tabular text-right whitespace-nowrap">{fmt.money(e.amount)}</Td>
                    <Td className="tabular text-right whitespace-nowrap text-muted-fg">{perLitre(e.amount, e.litres)}</Td>
                    <Td className="tabular text-right whitespace-nowrap">{e.odometer != null ? `${e.odometer.toLocaleString('en-KE')} km` : dash}</Td>
                    <Td>
                      {e.receiptKey ? (
                        <Button variant="link" size="sm" onClick={() => void openReceipt(e.id)}>
                          <Receipt /> View
                        </Button>
                      ) : (
                        dash
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">{e.enteredBy?.name ?? dash}</Td>
                    <Td>
                      <div className="flex gap-0.5">
                        <Button variant="ghost" size="icon-sm" onClick={() => setDialog({ entry: e })} aria-label="Edit entry">
                          <Pencil />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(e)} aria-label="Delete entry">
                          <Trash2 />
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryBlock>
      </Card>

      {dialog && <FuelDialog entry={dialog.entry} defaultCarId={carId} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this fuel entry?"
        description={
          deleting && (
            <>
              {deleting.car?.registration}: {litresText(deleting.litres)}, {fmt.money(deleting.amount)} on {fmt.date(deleting.date)}. Fuel reports will change.
            </>
          )
        }
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Page>
  );
}

function FuelDialog({ entry, defaultCarId, onClose }: { entry: FuelEntry | null; defaultCarId: string; onClose: () => void }) {
  const fmt = useFormat();
  const qc = useQueryClient();
  const cars = useReference().data?.cars ?? [];
  const fileId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const today = fmt.dateKey(new Date());
  const entryDay = entry ? fmt.dateKey(entry.date) : today;

  const [carId, setCarId] = useState(entry?.carId || defaultCarId || cars[0]?.id || '');
  const [type, setType] = useState<FuelEntryType>(entry?.type ?? 'FILL_UP');
  const [date, setDate] = useState(entryDay);
  const [month, setMonth] = useState(entryDay.slice(0, 7));
  const [litres, setLitres] = useState(str(entry?.litres));
  const [amount, setAmount] = useState(str(entry?.amount));
  const [odometer, setOdometer] = useState(str(entry?.odometer));
  const [notes, setNotes] = useState(entry?.notes ?? '');
  const [receiptKey, setReceiptKey] = useState<string | null>(entry?.receiptKey ?? null);
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const carOptions = [...cars];
  const missingCar = Boolean(entry && !cars.some((c) => c.id === entry.carId));

  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const key = file ? await uploadFile('RECEIPT', file) : receiptKey;
      const payload = { ...body, receiptKey: key };
      return entry ? put<FuelEntry>(`/admin/fuel/${entry.id}`, payload) : post<FuelEntry>('/admin/fuel', payload);
    },
    onSuccess: () => {
      toast.success(entry ? 'Fuel entry saved' : 'Fuel entry added');
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ['reports'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function pickFile(f: File | null) {
    if (f && f.type && !RECEIPT_TYPES.includes(f.type)) {
      setErrors((e) => ({ ...e, receipt: 'Use a photo (JPG, PNG, WebP, HEIC) or a PDF' }));
      return;
    }
    if (f && f.size > MAX_RECEIPT) {
      setErrors((e) => ({ ...e, receipt: 'The file is larger than 15 MB' }));
      return;
    }
    setErrors(({ receipt: _drop, ...rest }) => rest);
    setFile(f);
  }

  function submit() {
    const r = check(FuelEntrySchema, {
      carId,
      type,
      date: type === 'MONTHLY' ? (month ? `${month}-01` : '') : date,
      litres: numOrUndef(litres),
      amount: numOrUndef(amount),
      odometer: numOrNull(odometer),
      notes: textOrNull(notes),
    });
    if (!r.ok) {
      const errs = { ...r.errors };
      if (errs.carId) errs.carId = 'Choose a car';
      if (errs.date) errs.date = type === 'MONTHLY' ? 'Choose a month' : date ? errs.date : 'Required';
      return setErrors(errs);
    }
    setErrors({});
    save.mutate(r.data);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={entry ? 'Edit fuel entry' : 'Add fuel'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            {save.isPending && file ? 'Uploading…' : entry ? 'Save changes' : 'Add entry'}
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
        <Field label="Car" required error={errors.carId}>
          {(p) => (
            <Select {...p} value={carId} onChange={(e) => setCarId(e.target.value)}>
              <option value="">Choose a car</option>
              {entry && missingCar && <option value={entry.carId}>{entry.car?.registration ?? 'Retired car'}</option>}
              {carOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.registration} · {c.make} {c.model}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <Label>Type</Label>
          <Segmented<FuelEntryType>
            value={type}
            onChange={setType}
            options={[
              { value: 'FILL_UP', label: 'Fill-up' },
              { value: 'MONTHLY', label: 'Monthly total' },
            ]}
          />
        </div>
        {type === 'FILL_UP' ? (
          <Field label="Date" required error={errors.date}>
            {(p) => <Input {...p} type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />}
          </Field>
        ) : (
          <Field label="Month" required error={errors.date} hint="All fuel for the car in that month, e.g. from the fuel card statement.">
            {(p) => <Input {...p} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}
          </Field>
        )}
        <Field label="Odometer" error={errors.odometer} hint="Reading at the pump, if noted.">
          {(p) => <UnitInput {...p} unit="km" type="number" inputMode="numeric" min={0} step={1} value={odometer} onChange={(e) => setOdometer(e.target.value)} />}
        </Field>
        <Field label="Litres" required error={errors.litres} hint="Needed to work out km per litre.">
          {(p) => <UnitInput {...p} unit="L" type="number" min={0} step="0.01" value={litres} onChange={(e) => setLitres(e.target.value)} />}
        </Field>
        <Field label="Amount" required error={errors.amount}>
          {(p) => <UnitInput {...p} unit={fmt.currency} unitPosition="start" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={fileId}>Receipt</Label>
          <input
            ref={fileRef}
            id={fileId}
            type="file"
            accept={RECEIPT_TYPES.join(',')}
            className="sr-only"
            onChange={(e) => {
              pickFile(e.target.files?.[0] ?? null);
              e.target.value = '';
            }}
          />
          {file || receiptKey ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
              <Paperclip className="size-4 text-muted-fg" />
              <span className="min-w-0 flex-1 truncate">{file ? file.name : 'Receipt attached'}</span>
              {!file && entry?.receiptKey && receiptKey === entry.receiptKey && (
                <Button type="button" variant="link" size="sm" onClick={() => void openReceipt(entry.id)}>
                  View
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
                Replace
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove receipt"
                onClick={() => {
                  setFile(null);
                  setReceiptKey(null);
                }}
              >
                <X />
              </Button>
            </div>
          ) : (
            <div>
              <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
                <Paperclip /> Attach photo or PDF
              </Button>
            </div>
          )}
          {errors.receipt ? <p className="text-xs text-danger">{errors.receipt}</p> : <p className="text-xs text-muted-fg">Optional. Up to 15 MB.</p>}
        </div>

        <Field label="Notes" error={errors.notes} className="sm:col-span-2">
          {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
