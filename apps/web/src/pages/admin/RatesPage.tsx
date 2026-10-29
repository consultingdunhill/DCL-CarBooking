import { HourlyRateSchema, JobRoleSchema } from '@carbooking/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BriefcaseBusiness, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Callout, ConfirmDialog, FormError, QueryBlock, TableSkeleton, UnitInput } from '@/components/admin/common';
import { check, numOrUndef, type FieldErrors } from '@/components/admin/form-utils';
import { Page } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch } from '@/components/ui/form';
import { EmptyState, PageHeader } from '@/components/ui/misc';
import { del, errorMessage, get, post, put } from '@/lib/api';
import { useFormat } from '@/lib/format';
import type { HourlyRate, JobRole } from '@/lib/types';
import { cn } from '@/lib/utils';

const ROLES_KEY = ['admin', 'job-roles'] as const;
const RATES_KEY = ['admin', 'rates'] as const;
const DRIVER = 'driver';

interface RateGroup {
  key: string;
  name: string;
  inactive?: boolean;
  rates: HourlyRate[];
}

export function RatesPage() {
  const fmt = useFormat();
  const roles = useQuery({ queryKey: ROLES_KEY, queryFn: () => get<JobRole[]>('/admin/job-roles') });
  const rates = useQuery({ queryKey: RATES_KEY, queryFn: () => get<HourlyRate[]>('/admin/rates') });
  const [roleDialog, setRoleDialog] = useState<{ role: JobRole | null } | null>(null);
  const [rateDialog, setRateDialog] = useState<{ target: string } | null>(null);

  return (
    <Page wide>
      <PageHeader title="Hourly rates" description="What an hour of staff and driver time costs, used for trip, viewing and property costs." />
      <Callout className="mb-6">
        Rates are dated. A new rate applies from its start date, and earlier trips keep the rate that was in force at the time, so changing a rate doesn't rewrite
        past reports. Amounts are in {fmt.currency} per hour.
      </Callout>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader
            title="Job roles"
            description="Each user has one. Their time is costed at that role's rate."
            actions={
              <Button variant="secondary" size="sm" onClick={() => setRoleDialog({ role: null })}>
                <Plus /> Add role
              </Button>
            }
          />
          <QueryBlock
            query={roles}
            empty={
              <EmptyState
                icon={<BriefcaseBusiness />}
                title="No job roles yet"
                description="Add roles like “Sales Agent” or “Property Manager”, then give each user one."
                action={
                  <Button onClick={() => setRoleDialog({ role: null })}>
                    <Plus /> Add role
                  </Button>
                }
              />
            }
          >
            {(list) => (
              <ul className="divide-y divide-border">
                {list.map((r) => {
                  const users = r._count?.users ?? 0;
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <p className={cn('font-medium', !r.active && 'text-muted-fg')}>{r.name}</p>
                        <p className="tabular text-xs text-muted-fg">
                          {users} {users === 1 ? 'user' : 'users'}
                        </p>
                      </div>
                      {!r.active && <Badge>Inactive</Badge>}
                      <Button variant="ghost" size="icon-sm" onClick={() => setRoleDialog({ role: r })} aria-label={`Edit ${r.name}`}>
                        <Pencil />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </QueryBlock>
        </Card>

        <Card>
          <CardHeader
            title="Rates"
            description="Newest first. The rate in force today is marked."
            actions={
              <Button size="sm" onClick={() => setRateDialog({ target: DRIVER })}>
                <Plus /> Add rate
              </Button>
            }
          />
          {rates.isPending || roles.isPending ? (
            <TableSkeleton rows={6} />
          ) : (
            <QueryBlock query={rates}>
              {(list) => {
                const groups: RateGroup[] = [{ key: DRIVER, name: 'Driver', rates: list.filter((r) => r.forDriver) }];
                for (const role of roles.data ?? []) {
                  const own = list.filter((r) => !r.forDriver && r.jobRoleId === role.id);
                  if (role.active || own.length) groups.push({ key: role.id, name: role.name, inactive: !role.active, rates: own });
                }
                return (
                  <div className="divide-y divide-border">
                    {groups.map((g) => (
                      <RateGroupView key={g.key} group={g} onAdd={() => setRateDialog({ target: g.key })} />
                    ))}
                  </div>
                );
              }}
            </QueryBlock>
          )}
        </Card>
      </div>

      {roleDialog && <RoleDialog role={roleDialog.role} onClose={() => setRoleDialog(null)} />}
      {rateDialog && <RateDialog target={rateDialog.target} roles={roles.data ?? []} onClose={() => setRateDialog(null)} />}
    </Page>
  );
}

function RateGroupView({ group, onAdd }: { group: RateGroup; onAdd: () => void }) {
  const fmt = useFormat();
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState<HourlyRate | null>(null);
  const now = Date.now();
  const sorted = [...group.rates].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const current = sorted.find((r) => new Date(r.effectiveFrom).getTime() <= now);

  const remove = useMutation({
    mutationFn: (id: string) => del(`/admin/rates/${id}`),
    onSuccess: () => {
      toast.success('Rate deleted');
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: RATES_KEY });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <section className="px-5 py-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 className="flex items-center gap-2 font-medium">
          {group.name}
          {group.inactive && <Badge>Inactive role</Badge>}
        </h4>
        <Button variant="ghost" size="sm" onClick={onAdd}>
          <Plus /> New rate
        </Button>
      </div>
      {sorted.length === 0 ? (
        <p className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">No rate yet, so this time is costed at 0.</p>
      ) : (
        <ul className="space-y-1">
          {sorted.map((r) => {
            const future = new Date(r.effectiveFrom).getTime() > now;
            const inForce = r.id === current?.id;
            return (
              <li key={r.id} className={cn('flex items-center gap-3 rounded-lg px-3 py-2', inForce ? 'bg-accent' : 'text-muted-fg')}>
                <span className={cn('tabular w-32 shrink-0 font-medium', inForce && 'text-accent-fg')}>{fmt.money(r.rate)} / h</span>
                <span className="min-w-0 flex-1 text-sm">from {fmt.date(r.effectiveFrom)}</span>
                {inForce && <Badge tone="success">In force</Badge>}
                {future && <Badge tone="info">Scheduled</Badge>}
                <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(r)} aria-label={`Delete rate from ${fmt.date(r.effectiveFrom)}`}>
                  <Trash2 />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this rate?"
        description={
          deleting && (
            <>
              {group.name}: {fmt.money(deleting.rate)} / h from {fmt.date(deleting.effectiveFrom)}. Trips in its period will use the rate before it, or 0 if there is
              none. Use this to fix a mistake; to change a rate, add a new one instead.
            </>
          )
        }
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  );
}

function RoleDialog({ role, onClose }: { role: JobRole | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(role?.name ?? '');
  const [active, setActive] = useState(role?.active ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (body: unknown) => (role ? put<JobRole>(`/admin/job-roles/${role.id}`, body) : post<JobRole>('/admin/job-roles', body)),
    onSuccess: (saved) => {
      toast.success(role ? `${saved.name} saved` : `${saved.name} added`);
      void qc.invalidateQueries({ queryKey: ROLES_KEY });
      void qc.invalidateQueries({ queryKey: RATES_KEY });
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit() {
    const r = check(JobRoleSchema, { name, active });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    save.mutate(r.data);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={role ? 'Edit job role' : 'Add a job role'}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            {role ? 'Save' : 'Add role'}
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
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales Agent" autoFocus />}
        </Field>
        <Switch checked={active} onChange={setActive} label="Active" description="Inactive roles can't be given to users. Their rates stay for past trips." />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function RateDialog({ target: initialTarget, roles, onClose }: { target: string; roles: JobRole[]; onClose: () => void }) {
  const fmt = useFormat();
  const qc = useQueryClient();
  const today = fmt.dateKey(new Date());
  const [target, setTarget] = useState(initialTarget);
  const [rate, setRate] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (body: unknown) => post<HourlyRate>('/admin/rates', body),
    onSuccess: () => {
      toast.success('Rate added');
      void qc.invalidateQueries({ queryKey: RATES_KEY });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit() {
    const forDriver = target === DRIVER;
    const r = check(HourlyRateSchema, { jobRoleId: forDriver ? null : target || null, forDriver, rate: numOrUndef(rate), effectiveFrom });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    save.mutate(r.data);
  }

  const options = roles.filter((r) => r.active || r.id === target);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add an hourly rate"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            Add rate
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
        <Field label="Applies to" required error={errors.jobRoleId ?? errors.forDriver} className="sm:col-span-2">
          {(p) => (
            <Select {...p} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value={DRIVER}>Driver</option>
              {options.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Rate per hour" required error={errors.rate}>
          {(p) => <UnitInput {...p} unit={fmt.currency} unitPosition="start" type="number" min={0} step="any" value={rate} onChange={(e) => setRate(e.target.value)} autoFocus />}
        </Field>
        <Field
          label="Applies from"
          required
          error={errors.effectiveFrom}
          hint={effectiveFrom && effectiveFrom < today ? 'Back-dated: costs for trips since this date will change.' : 'Trips from this date use the new rate.'}
        >
          {(p) => <Input {...p} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />}
        </Field>
        <div className="sm:col-span-2">
          <FormError>{errors._form}</FormError>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
