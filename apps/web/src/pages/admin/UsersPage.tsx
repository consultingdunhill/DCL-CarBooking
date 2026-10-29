import { DEPARTMENT_LABELS, DEPARTMENTS, UserUpdateSchema, type Department, type Role } from '@carbooking/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Callout, dash, QueryBlock, SearchInput } from '@/components/admin/common';
import { check, textOrNull, type FieldErrors } from '@/components/admin/form-utils';
import { ROLE_LABELS } from '@/components/admin/labels';
import { Page } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Segmented, Select, Switch } from '@/components/ui/form';
import { EmptyState, PageHeader, Table, Td, Th } from '@/components/ui/misc';
import { errorMessage, get, patch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useReference } from '@/lib/queries';
import type { AdminUser, JobRole } from '@/lib/types';
import { cn } from '@/lib/utils';

const USERS_KEY = ['admin', 'users'] as const;
const ROLES_KEY = ['admin', 'job-roles'] as const;

export function UsersPage() {
  const fmt = useFormat();
  const authMode = useReference().data?.features.authMode;
  const users = useQuery({ queryKey: USERS_KEY, queryFn: () => get<AdminUser[]>('/admin/users') });
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!users.data || !q) return users.data ?? [];
    return users.data.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.phone ?? '').includes(q));
  }, [users.data, search]);

  const noJobRole = (users.data ?? []).filter((u) => u.active && !u.jobRole).length;

  return (
    <Page wide>
      <PageHeader
        title="Users"
        description={authMode === 'entra' ? 'Everyone who has signed in with Microsoft 365.' : 'Everyone who can sign in.'}
        actions={<SearchInput value={search} onChange={setSearch} placeholder="Search name, email or phone" />}
      />

      <div className="mb-4 space-y-3">
        {authMode === 'entra' ? (
          <Callout>Roles and access are managed in Microsoft 365 (Entra app roles). Here you set phone, department and job role.</Callout>
        ) : authMode === 'dev' ? (
          <Callout tone="neutral">Development sign-in: you can change roles and access here. With Microsoft 365 sign-in they come from Entra app roles.</Callout>
        ) : null}
        {noJobRole > 0 && (
          <Callout tone="warning" title={`${noJobRole} active ${noJobRole === 1 ? 'user has' : 'users have'} no job role`}>
            Their time is costed at 0 in trip and viewing costs. Give each person a job role; rates are set per job role in{' '}
            <Link to="/admin/rates" className="font-medium underline underline-offset-2">
              Hourly rates
            </Link>
            .
          </Callout>
        )}
      </div>

      <Card>
        <QueryBlock query={users} empty={<EmptyState icon={<Users />} title="No users yet" description="People appear here after they first sign in." />}>
          {() =>
            filtered.length === 0 ? (
              <EmptyState title="No matches" description={`Nobody matches “${search}”.`} />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Phone</Th>
                    <Th>Role</Th>
                    <Th>Department</Th>
                    <Th>Job role</Th>
                    <Th>Access</Th>
                    <Th>Last sign-in</Th>
                    <Th>Privacy notice</Th>
                    <Th className="w-0">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u) => (
                    // The whole row opens the editor, so it stays reachable when a narrow screen scrolls the pencil out of view.
                    <tr
                      key={u.id}
                      onClick={() => setEditing(u)}
                      className={cn('cursor-pointer transition-colors hover:bg-muted/50', !u.active && 'text-muted-fg', u.active && !u.jobRole && 'bg-warning-bg/40')}
                    >
                      <Td className="whitespace-nowrap">
                        <div className="font-medium">{u.name}</div>
                        <div className="text-xs text-muted-fg">{u.email}</div>
                      </Td>
                      <Td className="tabular whitespace-nowrap">{u.phone ?? dash}</Td>
                      <Td>{u.role === 'ADMIN' ? <Badge tone="primary">Admin</Badge> : <Badge>Staff</Badge>}</Td>
                      <Td className="whitespace-nowrap">{u.department ? DEPARTMENT_LABELS[u.department] : dash}</Td>
                      <Td className="whitespace-nowrap">{u.jobRole ? u.jobRole.name : <Badge tone="warning">None · costed at 0</Badge>}</Td>
                      <Td>{u.active ? <Badge tone="success">Active</Badge> : <Badge>Disabled</Badge>}</Td>
                      <Td className="whitespace-nowrap" title={u.lastLoginAt ? fmt.dateTime(u.lastLoginAt) : undefined}>
                        {u.lastLoginAt ? fmt.relative(u.lastLoginAt) : <span className="text-muted-fg">Never</span>}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {u.privacyAckAt ? (
                          <span className="inline-flex items-center gap-1" title={fmt.dateTime(u.privacyAckAt)}>
                            <Check className="size-4 text-success" /> {fmt.date(u.privacyAckAt)}
                          </span>
                        ) : (
                          <span className="text-muted-fg">Not yet</span>
                        )}
                      </Td>
                      <Td>
                        <Button variant="ghost" size="icon-sm" onClick={() => setEditing(u)} aria-label={`Edit ${u.name}`}>
                          <Pencil />
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryBlock>
      </Card>

      {editing && <UserDialog user={editing} devMode={authMode === 'dev'} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function UserDialog({ user, devMode, onClose }: { user: AdminUser; devMode: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const isSelf = me?.id === user.id;
  const jobRoles = useQuery({ queryKey: ROLES_KEY, queryFn: () => get<JobRole[]>('/admin/job-roles') });
  const [phone, setPhone] = useState(user.phone ?? '');
  const [department, setDepartment] = useState<Department | ''>(user.department ?? '');
  const [jobRoleId, setJobRoleId] = useState(user.jobRole?.id ?? '');
  const [role, setRole] = useState<Role>(user.role);
  const [active, setActive] = useState(user.active);
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (body: unknown) => patch(`/admin/users/${user.id}`, body),
    onSuccess: () => {
      toast.success(`${user.name} saved`);
      void qc.invalidateQueries({ queryKey: USERS_KEY });
      void qc.invalidateQueries({ queryKey: ROLES_KEY });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit() {
    const body = {
      phone: textOrNull(phone),
      department: department || null,
      jobRoleId: jobRoleId || null,
      ...(devMode && !isSelf ? { role, active } : {}),
    };
    const r = check(UserUpdateSchema, body);
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    save.mutate(r.data);
  }

  // Keep a now-inactive job role selectable if the user still has it.
  const roleOptions = (jobRoles.data ?? []).filter((j) => j.active || j.id === jobRoleId);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={user.name}
      description={user.email}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            Save changes
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
          <Field label="Phone" error={errors.phone} hint="Used for trip alerts and so colleagues can call.">
            {(p) => <Input {...p} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="tabular" />}
          </Field>
          <Field label="Department" error={errors.department}>
            {(p) => (
              <Select {...p} value={department} onChange={(e) => setDepartment(e.target.value as Department | '')}>
                <option value="">Not set</option>
                {DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {DEPARTMENT_LABELS[d]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Job role"
            error={errors.jobRoleId}
            className="sm:col-span-2"
            hint={jobRoleId ? 'Their time on trips is costed at this role’s hourly rate.' : 'Without a job role their time is costed at 0.'}
          >
            {(p) => (
              <Select {...p} value={jobRoleId} onChange={(e) => setJobRoleId(e.target.value)} disabled={jobRoles.isPending}>
                <option value="">{jobRoles.isPending ? 'Loading…' : 'No job role'}</option>
                {roleOptions.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                    {!j.active ? ' (inactive)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Role and access</p>
          {!devMode ? (
            <Callout>
              Roles and access are managed in Microsoft 365 (Entra app roles). Currently: {ROLE_LABELS[user.role]}, {user.active ? 'active' : 'disabled'}.
            </Callout>
          ) : isSelf ? (
            <p className="text-sm text-muted-fg">You can't change your own role or access.</p>
          ) : (
            <>
              <Segmented<Role>
                value={role}
                onChange={setRole}
                options={[
                  { value: 'STAFF', label: 'Staff' },
                  { value: 'ADMIN', label: 'Admin' },
                ]}
              />
              <Switch checked={active} onChange={setActive} label="Can sign in" description="Turn off for people who have left. Their past trips are kept." />
            </>
          )}
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
