import { DEPARTMENT_LABELS, DEPARTMENTS, MeUpdateSchema, type Department } from '@carbooking/core';
import { BatteryCharging, Bell, LogOut, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { InstallCard } from '@/components/InstallCard';
import { PrivacyNoticeText } from '@/components/PrivacyNotice';
import { Page } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/misc';
import { errorMessage, patch } from '@/lib/api';
import { useAuth, useMe } from '@/lib/auth';
import { isNative, platform } from '@/lib/env';
import { isIOS, isStandalone } from '@/lib/install';
import { enablePush, pushPermission, pushSupported } from '@/lib/push';

/** Brands that stop background apps aggressively (see dontkillmyapp.com). */
const BATTERY_STEPS: { brand: string; steps: string[] }[] = [
  {
    brand: 'All Android phones',
    steps: ['Settings → Apps → Fleet → Battery → choose "Unrestricted" (or "Don\'t optimise").', 'Settings → Apps → Fleet → Permissions → Location → "Allow all the time".'],
  },
  { brand: 'Samsung', steps: ['Settings → Battery → Background usage limits → remove Fleet from "Sleeping apps" and "Deep sleeping apps".', 'Add Fleet to "Never sleeping apps".'] },
  { brand: 'Tecno / Infinix / itel (HiOS, XOS)', steps: ['Phone Master → App management → Auto-start → turn Fleet on.', 'Settings → Battery → App battery management → Fleet → "No restrictions".', 'Open recent apps, pull Fleet down and lock it.'] },
  { brand: 'Xiaomi / Redmi / POCO', steps: ['Settings → Apps → Manage apps → Fleet → Autostart: on.', 'Battery saver → "No restrictions".', 'Lock Fleet in recent apps.'] },
  { brand: 'Oppo / Realme / OnePlus', steps: ['Settings → Battery → Fleet → allow background activity and auto-launch.'] },
  { brand: 'Huawei / Honor', steps: ['Settings → Battery → App launch → Fleet: manage manually, turn on all three switches.'] },
];

export function ProfilePage() {
  const me = useMe();
  const { signOut, refreshMe } = useAuth();
  const [phone, setPhone] = useState(me.phone ?? '');
  const [department, setDepartment] = useState<Department | ''>(me.department ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const [push, setPush] = useState(pushPermission());

  const save = async () => {
    const body = { phone: phone || null, department: department || null };
    const parsed = MeUpdateSchema.safeParse(body);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check your details');
    setError(null);
    setSaving(true);
    try {
      await patch('/me', body);
      await refreshMe();
      toast.success('Saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page>
      <PageHeader title={me.name} description={me.email} actions={<Badge tone={me.role === 'ADMIN' ? 'primary' : 'neutral'}>{me.role === 'ADMIN' ? 'Admin' : 'Staff'}</Badge>} />

      <div className="grid gap-4">
        <Card>
          <CardHeader title="Your details" description="Colleagues use your phone number to call or WhatsApp you about shared trips." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Mobile number" error={error}>
              {(p) => <Input {...p} type="tel" inputMode="tel" placeholder="07XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} />}
            </Field>
            <Field label="Department">
              {(p) => (
                <Select {...p} value={department} onChange={(e) => setDepartment(e.target.value as Department)}>
                  <option value="">—</option>
                  {DEPARTMENTS.map((d) => (
                    <option key={d} value={d}>
                      {DEPARTMENT_LABELS[d]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="sm:col-span-2">
              <Button loading={saving} onClick={save}>
                Save
              </Button>
            </div>
          </CardBody>
        </Card>

        <InstallCard />

        <Card>
          <CardHeader title="Notifications" description="Approvals, changes to your trips, and reminders." />
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm">
              <Bell className="size-4 text-muted-fg" />
              {!pushSupported() ? (isIOS && !isStandalone() ? 'On iPhone, add Fleet to your home screen first, then turn notifications on here.' : 'Push notifications aren\'t supported in this browser. You\'ll still get email.') :push === 'granted' ? 'Push notifications are on for this device.' : push === 'denied' ? 'Blocked in your browser settings.' : 'Get a notification on this device.'}
            </p>
            {pushSupported() && push !== 'granted' && push !== 'denied' && (
              <Button
                variant="secondary"
                onClick={async () => {
                  const ok = await enablePush().catch(() => false);
                  setPush(pushPermission());
                  toast[ok ? 'success' : 'error'](ok ? 'Notifications on' : 'Could not turn on notifications');
                }}
              >
                Turn on
              </Button>
            )}
          </CardBody>
        </Card>

        {(platform === 'android' || !isNative) && (
          <Card id="battery">
            <CardHeader title="Keep trip tracking running (Android)" description="Many Android phones stop background apps to save battery, which cuts off trip tracking. Do this once on the phone you use for trips." />
            <CardBody className="grid gap-4">
              {BATTERY_STEPS.map((b) => (
                <div key={b.brand}>
                  <p className="mb-1 flex items-center gap-2 text-sm font-medium">
                    <BatteryCharging className="size-4 text-primary" /> {b.brand}
                  </p>
                  <ol className="list-decimal space-y-0.5 pl-6 text-sm text-muted-fg">
                    {b.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                </div>
              ))}
              <p className="text-xs text-muted-fg">
                More help for your phone model:{' '}
                <a className="text-primary underline" href="https://dontkillmyapp.com" target="_blank" rel="noreferrer">
                  dontkillmyapp.com
                </a>
              </p>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-muted-fg" /> Location privacy notice
              {me.privacyAckAt && <span className="text-muted-fg">· accepted {new Date(me.privacyAckAt).toLocaleDateString()}</span>}
            </p>
            <Button variant="secondary" onClick={() => setNotice(true)}>
              Read it
            </Button>
          </CardBody>
        </Card>

        <Button variant="secondary" className="justify-self-start" onClick={() => void signOut()}>
          <LogOut /> Sign out
        </Button>
      </div>

      <Dialog open={notice} onOpenChange={setNotice} title="Location privacy notice">
        <PrivacyNoticeText />
      </Dialog>
    </Page>
  );
}
