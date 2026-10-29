import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import { Fragment, useState } from 'react';
import { dash, QueryBlock, useDebounced } from '@/components/admin/common';
import { Page } from '@/components/Shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/form';
import { EmptyState, PageHeader, Spinner, Table, Td, Th } from '@/components/ui/misc';
import { get, qs } from '@/lib/api';
import { useFormat } from '@/lib/format';
import type { AuditEntry } from '@/lib/types';
import { cn } from '@/lib/utils';

const LIMIT = 200;

/** Entities the API writes to the log, offered as suggestions. */
const KNOWN_ENTITIES = [
  'Booking',
  'Car',
  'Client',
  'ClosureImportBatch',
  'ClosureImportRow',
  'Driver',
  'FuelEntry',
  'HourlyRate',
  'JobRole',
  'JoinRequest',
  'Office',
  'Property',
  'Report',
  'Setting',
  'Trip',
  'User',
  'VisitReason',
];

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium tracking-wide text-muted-fg uppercase">{label}</p>
      {value == null ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-fg">Nothing</p>
      ) : (
        <pre className="max-h-80 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(value, null, 2)}</pre>
      )}
    </div>
  );
}

export function AuditPage() {
  const fmt = useFormat();
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const e = useDebounced(entity.trim());
  const a = useDebounced(action.trim().toUpperCase());
  const [open, setOpen] = useState<Set<string>>(new Set());

  const log = useQuery({
    queryKey: ['admin', 'audit', { entity: e, action: a }],
    queryFn: () => get<AuditEntry[]>(`/admin/audit${qs({ entity: e, action: a, limit: LIMIT })}`),
    placeholderData: keepPreviousData,
  });

  const seenActions = [...new Set((log.data ?? []).map((r) => r.action))].sort();
  const seenEntities = [...new Set([...KNOWN_ENTITIES, ...(log.data ?? []).map((r) => r.entity)])].sort();

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Page wide>
      <PageHeader title="Audit log" description="Who changed what, and when. Open a row to see the values before and after." />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-56">
          <Label htmlFor="audit-entity">Entity</Label>
          <Input id="audit-entity" list="audit-entities" value={entity} onChange={(ev) => setEntity(ev.target.value)} placeholder="e.g. Car" />
          <datalist id="audit-entities">
            {seenEntities.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </div>
        <div className="flex w-full flex-col gap-1.5 sm:w-64">
          <Label htmlFor="audit-action">Action</Label>
          <Input id="audit-action" list="audit-actions" value={action} onChange={(ev) => setAction(ev.target.value)} placeholder="e.g. CAR_UPDATED" className="font-mono" />
          <datalist id="audit-actions">
            {seenActions.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </div>
        {(entity || action) && (
          <Button
            variant="ghost"
            onClick={() => {
              setEntity('');
              setAction('');
            }}
          >
            Clear filters
          </Button>
        )}
        {log.isFetching && !log.isPending && <Spinner className="mb-2.5 size-4" />}
      </div>
      <p className="-mt-2 mb-4 text-xs text-muted-fg">Filters match exactly. Showing the latest {LIMIT} entries.</p>

      <Card>
        <QueryBlock
          query={log}
          empty={
            <EmptyState
              icon={<ShieldCheck />}
              title={e || a ? 'No matching entries' : 'Nothing logged yet'}
              description={e || a ? 'Check the spelling: entity and action must match exactly.' : 'Changes made by admins and the system appear here.'}
            />
          }
        >
          {(rows) => (
            <Table>
              <thead>
                <tr>
                  <Th className="w-0">
                    <span className="sr-only">Details</span>
                  </Th>
                  <Th>Time</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  <Th>Entity id</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isOpen = open.has(r.id);
                  return (
                    <Fragment key={r.id}>
                      <tr className={cn('cursor-pointer hover:bg-muted/50', isOpen && 'bg-muted/50')} onClick={() => toggle(r.id)}>
                        <Td className="pr-0">
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-label={isOpen ? 'Hide details' : 'Show details'}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              toggle(r.id);
                            }}
                            className="grid size-7 place-items-center rounded-md text-muted-fg hover:bg-muted hover:text-fg"
                          >
                            <ChevronRight className={cn('size-4 transition-transform', isOpen && 'rotate-90')} />
                          </button>
                        </Td>
                        <Td className="tabular whitespace-nowrap">{fmt.dateTime(r.at)}</Td>
                        <Td className="whitespace-nowrap">{r.actor?.name ?? <span className="text-muted-fg">System</span>}</Td>
                        <Td className="font-mono text-xs whitespace-nowrap">{r.action}</Td>
                        <Td className="whitespace-nowrap">{r.entity}</Td>
                        <Td className="font-mono text-xs whitespace-nowrap text-muted-fg" title={r.entityId ?? undefined}>
                          {r.entityId ? `${r.entityId.slice(0, 8)}…` : dash}
                        </Td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <Td colSpan={6} className="bg-surface-2">
                            <div className="grid gap-4 py-1 lg:grid-cols-2">
                              <Json label="Before" value={r.before} />
                              <Json label="After" value={r.after} />
                            </div>
                            {r.entityId && <p className="mt-3 font-mono text-xs break-all text-muted-fg">Entity id: {r.entityId}</p>}
                          </Td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          )}
        </QueryBlock>
      </Card>
    </Page>
  );
}
