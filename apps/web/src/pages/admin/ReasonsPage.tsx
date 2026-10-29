import { DEPARTMENT_LABELS, DEPARTMENTS, VisitReasonSchema, type Department } from '@carbooking/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ChevronDown, ChevronUp, Pencil, Plus, Tags } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { QueryBlock, TableSkeleton } from '@/components/admin/common';
import { check, type FieldErrors } from '@/components/admin/form-utils';
import { Page } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch } from '@/components/ui/form';
import { EmptyState, PageHeader } from '@/components/ui/misc';
import { errorMessage, get, post, put } from '@/lib/api';
import type { VisitReason } from '@/lib/types';
import { cn } from '@/lib/utils';

type ReasonRow = VisitReason & { _count?: { stops: number } };
const KEY = ['admin', 'reasons'] as const;

const bySort = (a: ReasonRow, b: ReasonRow) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label);

export function ReasonsPage() {
  const qc = useQueryClient();
  const reasons = useQuery({ queryKey: KEY, queryFn: () => get<ReasonRow[]>('/admin/reasons') });
  const [dialog, setDialog] = useState<{ reason: ReasonRow | null; department?: Department } | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ['reference'] });
  };

  const reorder = useMutation({
    mutationFn: (ids: string[]) => post('/admin/reasons/reorder', { ids }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: KEY });
      const prev = qc.getQueryData<ReasonRow[]>(KEY);
      if (prev) qc.setQueryData<ReasonRow[]>(KEY, prev.map((r) => (ids.includes(r.id) ? { ...r, sortOrder: ids.indexOf(r.id) } : r)));
      return { prev };
    },
    onError: (err, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(KEY, ctx.prev);
      toast.error(errorMessage(err));
    },
    onSettled: refresh,
  });

  const setActive = useMutation({
    mutationFn: (r: ReasonRow) =>
      put<VisitReason>(`/admin/reasons/${r.id}`, {
        label: r.label,
        department: r.department,
        countsAsViewing: r.countsAsViewing,
        needsProperty: r.needsProperty,
        sortOrder: r.sortOrder,
        active: !r.active,
      }),
    onSuccess: (saved) => {
      toast.success(saved.active ? `"${saved.label}" restored` : `"${saved.label}" archived. It stays in past trips and reports.`);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function move(list: ReasonRow[], all: ReasonRow[], index: number, delta: -1 | 1) {
    const next = [...list];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    // Archived reasons of the department go after the active ones so orders don't clash.
    const archived = all.filter((r) => !r.active && r.department === item!.department).sort(bySort);
    reorder.mutate([...next, ...archived].map((r) => r.id));
  }

  return (
    <Page>
      <PageHeader
        title="Visit reasons"
        description="What staff choose for each stop. Reasons drive the viewing and cost reports."
        actions={
          <Button onClick={() => setDialog({ reason: null })}>
            <Plus /> Add reason
          </Button>
        }
      />
      <QueryBlock
        query={reasons}
        skeleton={
          <Card>
            <TableSkeleton rows={6} />
          </Card>
        }
        empty={
          <Card>
            <EmptyState
              icon={<Tags />}
              title="No visit reasons yet"
              description="Add reasons like “Sales viewing” or “Rent collection” so staff can say why they need the car."
              action={
                <Button onClick={() => setDialog({ reason: null })}>
                  <Plus /> Add reason
                </Button>
              }
            />
          </Card>
        }
      >
        {(all) => {
          const archived = all.filter((r) => !r.active).sort((a, b) => a.label.localeCompare(b.label));
          return (
            <div className="space-y-5">
              {DEPARTMENTS.map((dept) => {
                const list = all.filter((r) => r.active && r.department === dept).sort(bySort);
                return (
                  <Card key={dept}>
                    <CardHeader
                      title={DEPARTMENT_LABELS[dept]}
                      description={list.length === 0 ? 'No active reasons' : `${list.length} active`}
                      actions={
                        <Button variant="ghost" size="sm" onClick={() => setDialog({ reason: null, department: dept })}>
                          <Plus /> Add
                        </Button>
                      }
                    />
                    {list.length > 0 && (
                      <ul className="divide-y divide-border">
                        {list.map((r, i) => (
                          <ReasonItem
                            key={r.id}
                            reason={r}
                            actions={
                              <>
                                <Button variant="ghost" size="icon-sm" disabled={i === 0 || reorder.isPending} onClick={() => move(list, all, i, -1)} aria-label={`Move ${r.label} up`}>
                                  <ChevronUp />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled={i === list.length - 1 || reorder.isPending}
                                  onClick={() => move(list, all, i, 1)}
                                  aria-label={`Move ${r.label} down`}
                                >
                                  <ChevronDown />
                                </Button>
                                <Button variant="ghost" size="icon-sm" onClick={() => setDialog({ reason: r })} aria-label={`Edit ${r.label}`}>
                                  <Pencil />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => setActive.mutate(r)}
                                  disabled={setActive.isPending && setActive.variables?.id === r.id}
                                  aria-label={`Archive ${r.label}`}
                                  title="Archive"
                                >
                                  <Archive />
                                </Button>
                              </>
                            }
                          />
                        ))}
                      </ul>
                    )}
                  </Card>
                );
              })}

              {archived.length > 0 && (
                <Card className="bg-surface-2">
                  <CardHeader title="Archived" description="Hidden from booking. They stay in past trips and reports, and you can restore them." />
                  <ul className="divide-y divide-border">
                    {archived.map((r) => (
                      <ReasonItem
                        key={r.id}
                        reason={r}
                        muted
                        actions={
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setActive.mutate(r)}
                            loading={setActive.isPending && setActive.variables?.id === r.id}
                          >
                            <ArchiveRestore /> Restore
                          </Button>
                        }
                      />
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          );
        }}
      </QueryBlock>

      {dialog && <ReasonDialog reason={dialog.reason} department={dialog.department} all={reasons.data ?? []} onClose={() => setDialog(null)} onSaved={refresh} />}
    </Page>
  );
}

function ReasonItem({ reason: r, actions, muted }: { reason: ReasonRow; actions: React.ReactNode; muted?: boolean }) {
  const uses = r._count?.stops ?? 0;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className={cn('font-medium', muted && 'text-muted-fg')}>{r.label}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {muted && <Badge>{DEPARTMENT_LABELS[r.department]}</Badge>}
          {r.countsAsViewing && <Badge tone="primary">Viewing</Badge>}
          {r.needsProperty && <Badge tone="info">Needs a property</Badge>}
          <span className="tabular text-xs text-muted-fg">
            Used on {uses.toLocaleString('en-KE')} {uses === 1 ? 'stop' : 'stops'}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-0.5">{actions}</div>
    </li>
  );
}

function ReasonDialog({
  reason,
  department,
  all,
  onClose,
  onSaved,
}: {
  reason: ReasonRow | null;
  department?: Department;
  all: ReasonRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(reason?.label ?? '');
  const [dept, setDept] = useState<Department>(reason?.department ?? department ?? 'SALES');
  const [countsAsViewing, setViewing] = useState(reason?.countsAsViewing ?? false);
  const [needsProperty, setNeedsProperty] = useState(reason?.needsProperty ?? false);
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (body: unknown) => (reason ? put<VisitReason>(`/admin/reasons/${reason.id}`, body) : post<VisitReason>('/admin/reasons', body)),
    onSuccess: (saved) => {
      toast.success(reason ? `"${saved.label}" saved` : `"${saved.label}" added`);
      onSaved();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit() {
    // Moving to another department puts the reason at the end of that list.
    let sortOrder = reason?.sortOrder;
    if (reason && dept !== reason.department) {
      sortOrder = Math.max(-1, ...all.filter((r) => r.department === dept).map((r) => r.sortOrder)) + 1;
    }
    const r = check(VisitReasonSchema, { label, department: dept, countsAsViewing, needsProperty, sortOrder, active: reason?.active ?? true });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    save.mutate(r.data);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={reason ? 'Edit reason' : 'Add a visit reason'}
      description={reason && (reason._count?.stops ?? 0) > 0 ? 'Changes also show on past trips that used this reason.' : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            {reason ? 'Save changes' : 'Add reason'}
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label" required error={errors.label}>
            {(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sales viewing" autoFocus />}
          </Field>
          <Field label="Department" required error={errors.department}>
            {(p) => (
              <Select {...p} value={dept} onChange={(e) => setDept(e.target.value as Department)}>
                {DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {DEPARTMENT_LABELS[d]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Switch checked={countsAsViewing} onChange={setViewing} label="Counts as a viewing" description="Included in viewing counts, cost per viewing and staff effectiveness." />
        <Switch checked={needsProperty} onChange={setNeedsProperty} label="Needs a property" description="Staff must pick a property from the portfolio for this stop." />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
