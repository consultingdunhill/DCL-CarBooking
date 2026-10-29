import { OfficeSchema, SettingsSchema, type LatLng, type Settings, type StopCostSplit, type WorkingHours } from '@carbooking/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout, FormError, UnitInput } from '@/components/admin/common';
import { check, numOrUndef, str, type FieldErrors } from '@/components/admin/form-utils';
import { NAIROBI } from '@/components/admin/labels';
import { MapPicker } from '@/components/admin/MapPicker';
import { WhatsappCard } from '@/components/admin/WhatsappCard';
import type { MapCircle } from '@/components/map/MapView';
import { Page } from '@/components/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Label, Segmented, Switch } from '@/components/ui/form';
import { ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { errorMessage, get, patch, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Office } from '@/lib/types';
import { cn } from '@/lib/utils';

const OFFICE_KEY = ['admin', 'office'] as const;
const SETTINGS_KEY = ['admin', 'settings'] as const;
const ARRIVAL_COLOR = '#0f5e57';
const WAKEUP_COLOR = '#1f4fbf';

export function SettingsPage() {
  const office = useQuery({ queryKey: OFFICE_KEY, queryFn: () => get<Office | null>('/admin/office') });
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => get<Settings>('/admin/settings'), refetchOnWindowFocus: false, staleTime: Infinity });

  return (
    <Page>
      <PageHeader title="Office & settings" description="Where the cars live, and the rules the app uses for bookings, tracking and reports." />
      <div className="space-y-6">
        {office.isPending ? (
          <CardSkeleton />
        ) : office.isError ? (
          <Card>
            <ErrorState error={office.error} retry={() => void office.refetch()} />
          </Card>
        ) : (
          <OfficeCard office={office.data} />
        )}

        <WhatsappCard />

        {settings.isPending ? (
          <CardSkeleton />
        ) : settings.isError ? (
          <Card>
            <ErrorState error={settings.error} retry={() => void settings.refetch()} />
          </Card>
        ) : (
          <SettingsForm initial={settings.data} />
        )}
      </div>
    </Page>
  );
}

function CardSkeleton() {
  return (
    <Card className="space-y-3 p-5">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-56 w-full" />
    </Card>
  );
}

// ── Office ────────────────────────────────────────────────────────────────────

function OfficeCard({ office }: { office: Office | null }) {
  const qc = useQueryClient();
  const [name, setName] = useState(office?.name ?? '');
  const [address, setAddress] = useState(office?.address ?? '');
  const [point, setPoint] = useState<LatLng | null>(office ? { lat: office.lat, lng: office.lng } : null);
  const [arrival, setArrival] = useState(str(office?.arrivalRadiusM ?? 20));
  const [wakeup, setWakeup] = useState(str(office?.wakeupRadiusM ?? 150));
  const [errors, setErrors] = useState<FieldErrors>({});

  const arrivalM = Number(arrival);
  const wakeupM = Number(wakeup);
  const circles = useMemo<MapCircle[]>(() => {
    if (!point) return [];
    const out: MapCircle[] = [];
    if (wakeupM > 0) out.push({ id: 'wakeup', center: point, radiusM: wakeupM, color: WAKEUP_COLOR });
    if (arrivalM > 0) out.push({ id: 'arrival', center: point, radiusM: arrivalM, color: ARRIVAL_COLOR });
    return out;
  }, [point, arrivalM, wakeupM]);

  const save = useMutation({
    mutationFn: (body: unknown) => put<Office>('/admin/office', body),
    onSuccess: (saved) => {
      toast.success('Office saved');
      qc.setQueryData(OFFICE_KEY, saved);
      void qc.invalidateQueries({ queryKey: ['reference'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit() {
    const r = check(OfficeSchema, {
      name,
      address,
      lat: point?.lat,
      lng: point?.lng,
      arrivalRadiusM: numOrUndef(arrival),
      wakeupRadiusM: numOrUndef(wakeup),
    });
    const errs: FieldErrors = r.ok ? {} : { ...r.errors };
    if (!point) errs.point = 'Click the map to set the parking point';
    if (r.ok && r.data.wakeupRadiusM <= r.data.arrivalRadiusM) errs.wakeupRadiusM = 'Must be larger than the arrival zone';
    if (!r.ok || Object.keys(errs).length) return setErrors(errs);
    setErrors({});
    save.mutate(r.data);
  }

  return (
    <Card>
      <CardHeader title="Office" description="Where trips start and end. Cars park here between trips." />
      <CardBody>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required error={errors.name}>
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Head Office" />}
            </Field>
            <Field label="Address" required error={errors.address}>
              {(p) => <Input {...p} value={address} onChange={(e) => setAddress(e.target.value)} />}
            </Field>
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <Label>Parking point</Label>
              {point && (
                <span className="tabular text-xs text-muted-fg">
                  {point.lat.toFixed(6)}, {point.lng.toFixed(6)}
                </span>
              )}
            </div>
            <MapPicker value={point} onChange={setPoint} center={NAIROBI} kind="office" circles={circles} title="Parking point" className="h-72" zoom={18} />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-fg">
              <span>Click where the cars park.</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full border-2" style={{ borderColor: ARRIVAL_COLOR }} /> Arrival zone
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full border-2" style={{ borderColor: WAKEUP_COLOR }} /> Wake-up geofence
              </span>
            </div>
            {errors.point && <p className="text-xs text-danger">{errors.point}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Arrival zone" required error={errors.arrivalRadiusM} hint="Back at the office once the car is inside this circle. Default 20 m.">
              {(p) => <UnitInput {...p} unit="m" type="number" inputMode="numeric" min={5} max={500} value={arrival} onChange={(e) => setArrival(e.target.value)} />}
            </Field>
            <Field label="Wake-up geofence" required error={errors.wakeupRadiusM} hint="Wakes the app as the car approaches. Default 150 m.">
              {(p) => <UnitInput {...p} unit="m" type="number" inputMode="numeric" min={100} max={2000} value={wakeup} onChange={(e) => setWakeup(e.target.value)} />}
            </Field>
          </div>

          <Callout title="Why two zones?">
            Phone GPS is only accurate to about 5–20 m, and the phone's own geofences are unreliable below about 100 m. So the larger wake-up geofence wakes the
            app as the car comes back, and the small arrival zone, checked against live GPS, decides that the car is actually back.
          </Callout>

          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>
              Save office
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────

type NumKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

interface NumField {
  key: NumKey;
  label: string;
  unit: string;
  hint: string;
  step?: string;
}

const BOOKING_FIELDS: NumField[] = [
  { key: 'startWindowMin', label: 'Start window', unit: 'min', hint: 'How early the trip owner can start the trip.' },
  { key: 'noShowWindowMin', label: 'No-show after', unit: 'min', hint: "A booking that hasn't started this long after its start time is a no-show." },
  { key: 'overdueGraceMin', label: 'Overdue grace', unit: 'min', hint: 'A trip counts as overdue this long after its expected return.' },
  { key: 'endPromptTimeoutMin', label: 'End prompt timeout', unit: 'min', hint: "If the trip isn't ended this long after reaching the office, it waits for an odometer reading." },
  { key: 'awaitingOdometerReminderMin', label: 'Odometer reminder every', unit: 'min', hint: 'How often to remind the owner to enter the end reading.' },
];

const TRACKING_FIELDS: NumField[] = [
  { key: 'heartbeatIntervalMin', label: 'Heartbeat interval', unit: 'min', hint: 'How often a parked phone checks in during a trip.' },
  { key: 'offlineThresholdMin', label: 'Offline after', unit: 'min', hint: 'No contact for this long shows “Offline since…”.' },
  { key: 'trackingLostThresholdMin', label: 'Tracking lost after', unit: 'min', hint: 'No contact for this long shows “Tracking lost” and alerts admins.' },
  { key: 'lowBatteryPct', label: 'Low battery warning', unit: '%', hint: 'Warn the trip owner at or below this level.' },
  { key: 'deadBatteryPct', label: 'Dead battery', unit: '%', hint: 'At or below this with no contact, tracking counts as lost straight away.' },
  { key: 'maxFixAccuracyM', label: 'Ignore GPS fixes worse than', unit: 'm', hint: 'Less accurate fixes are left out of distance and zone checks.' },
];

const STOP_FIELDS: NumField[] = [
  { key: 'stopArrivalRadiusM', label: 'Stop arrival radius', unit: 'm', hint: 'Within this distance of a stop counts as arrived.' },
  { key: 'stopDwellMin', label: 'Stop dwell', unit: 'min', hint: 'Time within the radius before a stop is marked arrived.', step: '0.5' },
  { key: 'officeDwellMin', label: 'Office dwell', unit: 'min', hint: 'Time in the office arrival zone before the car counts as back.', step: '0.5' },
];

const REPORT_FIELDS: NumField[] = [
  { key: 'odometerVarianceThresholdPct', label: 'Odometer vs GPS variance', unit: '%', hint: 'Flag trips where odometer km and GPS km differ by more than this.' },
  { key: 'manyViewingsThreshold', label: 'Many viewings', unit: 'viewings', hint: 'Flag properties with at least this many viewings and no closure.' },
];

const PRIVACY_FIELDS: NumField[] = [
  { key: 'gpsRetentionMonths', label: 'Keep GPS points for', unit: 'months', hint: 'Location points from older trips are deleted; trip summaries are kept.' },
];

const ALL_NUM_FIELDS = [...BOOKING_FIELDS, ...TRACKING_FIELDS, ...STOP_FIELDS, ...REPORT_FIELDS, ...PRIVACY_FIELDS];

// Monday first; index 0 is Sunday.
const WEEK = [
  { i: 1, label: 'Monday' },
  { i: 2, label: 'Tuesday' },
  { i: 3, label: 'Wednesday' },
  { i: 4, label: 'Thursday' },
  { i: 5, label: 'Friday' },
  { i: 6, label: 'Saturday' },
  { i: 0, label: 'Sunday' },
];

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function SettingsForm({ initial }: { initial: Settings }) {
  const qc = useQueryClient();
  const { refreshMe } = useAuth();
  const toText = (s: Settings) => Object.fromEntries(ALL_NUM_FIELDS.map((f) => [f.key, String(s[f.key])])) as Record<NumKey, string>;

  const [nums, setNums] = useState(() => toText(initial));
  const [currency, setCurrency] = useState(initial.currency);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [hours, setHours] = useState<WorkingHours>(initial.workingHours);
  const [split, setSplit] = useState<StopCostSplit>(initial.stopCostSplit);
  const [privacyVersion, setPrivacyVersion] = useState(initial.privacyNoticeVersion);
  const [errors, setErrors] = useState<FieldErrors>({});

  const draft: Record<string, unknown> = {
    ...initial,
    ...Object.fromEntries(ALL_NUM_FIELDS.map((f) => [f.key, numOrUndef(nums[f.key])])),
    currency: currency.trim().toUpperCase(),
    timezone: timezone.trim(),
    workingHours: hours,
    stopCostSplit: split,
    privacyNoticeVersion: privacyVersion.trim(),
  };
  const changed = (Object.keys(initial) as (keyof Settings)[]).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(initial[k]));
  const privacyChanged = changed.includes('privacyNoticeVersion');

  function reset(s: Settings) {
    setNums(toText(s));
    setCurrency(s.currency);
    setTimezone(s.timezone);
    setHours(s.workingHours);
    setSplit(s.stopCostSplit);
    setPrivacyVersion(s.privacyNoticeVersion);
    setErrors({});
  }

  const save = useMutation({
    mutationFn: (body: Partial<Settings>) => patch<Settings>('/admin/settings', body),
    onSuccess: (after, body) => {
      toast.success(`Settings saved (${Object.keys(body).length} ${Object.keys(body).length === 1 ? 'change' : 'changes'})`);
      qc.setQueryData(SETTINGS_KEY, after);
      reset(after);
      void qc.invalidateQueries({ queryKey: ['reference'] });
      if ('privacyNoticeVersion' in body) void refreshMe();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit() {
    const body = Object.fromEntries(changed.map((k) => [k, draft[k]]));
    const r = check(SettingsSchema.partial(), body);
    const errs: FieldErrors = r.ok ? {} : { ...r.errors };
    for (const f of ALL_NUM_FIELDS) if (nums[f.key].trim() === '') errs[f.key] = 'Required';
    if (!currency.trim()) errs.currency = 'Required';
    if (!timezone.trim()) errs.timezone = 'Required';
    if (!privacyVersion.trim()) errs.privacyNoticeVersion = 'Required';
    hours.forEach((day, i) => {
      day.forEach(([a, b]) => {
        if (a && b && b <= a) errs[`workingHours.${i}`] = 'Closing time must be after opening time';
      });
    });
    if ('timezone' in body && !validTimezone(String(body.timezone))) errs.timezone = 'Unknown timezone';
    const offline = Number(draft.offlineThresholdMin);
    const lost = Number(draft.trackingLostThresholdMin);
    if (Number.isFinite(offline) && Number.isFinite(lost) && lost <= offline && !errs.trackingLostThresholdMin) {
      errs.trackingLostThresholdMin = 'Must be longer than “Offline after”';
    }
    if (!r.ok || Object.keys(errs).length) {
      setErrors(errs);
      toast.error('Check the highlighted settings');
      // Bring the first problem into view once the errors have rendered.
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>('[data-settings-form] [aria-invalid="true"]');
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el?.focus({ preventScroll: true });
      });
      return;
    }
    setErrors({});
    save.mutate(r.data);
  }

  const numField = (f: NumField) => (
    <Field key={f.key} label={f.label} hint={f.hint} error={errors[f.key]}>
      {(p) => (
        <UnitInput
          {...p}
          unit={f.unit}
          type="number"
          step={f.step ?? '1'}
          value={nums[f.key]}
          onChange={(e) => setNums((n) => ({ ...n, [f.key]: e.target.value }))}
          className={cn(f.unit.length > 4 && 'pr-24')}
        />
      )}
    </Field>
  );

  function setDay(i: number, windows: [string, string][]) {
    setHours((h) => h.map((d, j) => (j === i ? windows : d)) as WorkingHours);
  }

  return (
    <form
      data-settings-form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Section title="Currency and time" description="Used for every amount and time the app shows.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Currency" error={errors.currency} hint="Three-letter code, e.g. KES. Fuel entries keep the currency they were entered in.">
            {(p) => <Input {...p} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} className="uppercase" />}
          </Field>
          <Field label="Timezone" error={errors.timezone} hint="IANA name, e.g. Africa/Nairobi (East Africa Time).">
            {(p) => <Input {...p} value={timezone} onChange={(e) => setTimezone(e.target.value)} spellCheck={false} />}
          </Field>
        </div>
      </Section>

      <Section title="Working hours" description="Used for utilisation %: booked hours as a share of working hours.">
        <div className="divide-y divide-border">
          {WEEK.map(({ i, label }) => {
            const day = hours[i] ?? [];
            const first = day[0];
            const open = Boolean(first);
            return (
              <div key={i} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span className="w-24 text-sm font-medium">{label}</span>
                  <div className="w-24">
                    <Switch checked={open} onChange={(on) => setDay(i, on ? [['08:00', '18:00']] : [])} label={open ? 'Open' : 'Closed'} />
                  </div>
                  {first && (
                    <div className="flex items-center gap-2">
                      <Input
                        type="time"
                        aria-label={`${label} opens`}
                        value={first[0]}
                        onChange={(e) => setDay(i, [[e.target.value, first[1]], ...day.slice(1)])}
                        className="tabular w-32"
                        aria-invalid={errors[`workingHours.${i}`] ? true : undefined}
                      />
                      <span className="text-muted-fg">–</span>
                      <Input
                        type="time"
                        aria-label={`${label} closes`}
                        value={first[1]}
                        onChange={(e) => setDay(i, [[first[0], e.target.value], ...day.slice(1)])}
                        className="tabular w-32"
                        aria-invalid={errors[`workingHours.${i}`] ? true : undefined}
                      />
                      {day.length > 1 && <span className="text-xs text-muted-fg">+{day.length - 1} more kept</span>}
                    </div>
                  )}
                </div>
                {errors[`workingHours.${i}`] && <p className="mt-1 text-xs text-danger sm:ml-28">{errors[`workingHours.${i}`]}</p>}
              </div>
            );
          })}
        </div>
        {errors.workingHours && <FormError>{errors.workingHours}</FormError>}
      </Section>

      <Section title="Bookings and trips" description="When trips can start, when they're late, and how they end.">
        <div className="grid gap-4 sm:grid-cols-2">{BOOKING_FIELDS.map(numField)}</div>
      </Section>

      <Section title="Tracking" description="How the live map decides a phone is offline or lost.">
        <div className="grid gap-4 sm:grid-cols-2">{TRACKING_FIELDS.map(numField)}</div>
      </Section>

      <Section title="Stops and arrival" description="How the app spots arrival at a stop and back at the office.">
        <div className="grid gap-4 sm:grid-cols-2">{STOP_FIELDS.map(numField)}</div>
      </Section>

      <Section title="Reports and costs" description="Flags and cost rules used in the reports.">
        <div className="grid gap-4 sm:grid-cols-2">{REPORT_FIELDS.map(numField)}</div>
        <div className="space-y-2 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Label>Stop cost split</Label>
            <Badge tone="warning">On hold with the business — provisional</Badge>
          </div>
          <Segmented<StopCostSplit>
            value={split}
            onChange={setSplit}
            options={[
              { value: 'EQUAL', label: 'Equal shares' },
              { value: 'DWELL_TIME', label: 'By time at each stop' },
            ]}
          />
          <p className="text-xs text-muted-fg">How a trip's fuel and travel time are shared across its stops. Time spent at each stop is always costed to that stop.</p>
        </div>
      </Section>

      <Section title="Privacy" description="Kenya Data Protection Act: how long location data is kept and which notice staff accepted.">
        <div className="grid gap-4 sm:grid-cols-2">
          {PRIVACY_FIELDS.map(numField)}
          <Field label="Privacy notice version" error={errors.privacyNoticeVersion} hint="Staff accept this version before their location is tracked.">
            {(p) => <Input {...p} value={privacyVersion} onChange={(e) => setPrivacyVersion(e.target.value)} />}
          </Field>
        </div>
        {privacyChanged && (
          <Callout tone="warning" title="Everyone will re-acknowledge">
            Changing the version asks every user, you included, to read and accept the privacy notice again before their next trip. Only change it when the
            notice itself has changed.
          </Callout>
        )}
      </Section>

      <div
        className={cn(
          'sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:shadow-card',
          changed.length === 0 && 'hidden',
        )}
      >
        <span className="mr-auto text-sm text-muted-fg">
          {changed.length} unsaved {changed.length === 1 ? 'change' : 'changes'}
        </span>
        <Button type="button" variant="ghost" onClick={() => reset(initial)} disabled={save.isPending}>
          Discard
        </Button>
        <Button type="submit" loading={save.isPending}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody className="space-y-4">{children}</CardBody>
    </Card>
  );
}
