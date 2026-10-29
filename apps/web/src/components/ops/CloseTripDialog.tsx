import { MAX_TRIP_KM } from '@carbooking/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';
import { errorMessage, post } from '@/lib/api';
import { useFormat } from '@/lib/format';

/**
 * Admin closes a trip that the owner didn't end (usually AWAITING_ODOMETER):
 * end odometer reading, how it was obtained, and optionally when it ended.
 */
export function CloseTripDialog({
  open,
  onOpenChange,
  tripId,
  carRegistration,
  odometerStart,
  defaultEndHint,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tripId: string;
  carRegistration: string;
  odometerStart: number;
  /** Explains what end time is used when left blank. */
  defaultEndHint?: string;
}) {
  const fmt = useFormat();
  const qc = useQueryClient();
  const [odometer, setOdometer] = useState('');
  const [note, setNote] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setOdometer('');
      setNote('');
      setEndDate('');
      setEndTime('');
      setSubmitted(false);
    }
  }, [open]);

  const reading = odometer.trim() === '' ? null : Number(odometer);
  const odoError =
    reading == null
      ? 'Enter the end odometer reading'
      : !Number.isInteger(reading) || reading < 0
        ? 'Enter whole km'
        : reading < odometerStart
          ? `Must be at least the start reading (${odometerStart.toLocaleString()} km)`
          : reading - odometerStart > MAX_TRIP_KM
            ? `That would be a ${(reading - odometerStart).toLocaleString()} km trip. Check the reading.`
            : null;
  const noteError = note.trim().length < 3 ? 'Say how the reading was obtained' : null;
  const timeError = (endDate && !endTime) || (!endDate && endTime) ? 'Enter both the date and the time, or leave both blank' : null;

  const close = useMutation({
    mutationFn: () =>
      post(`/trips/${tripId}/admin-close`, {
        odometer: reading,
        note: note.trim(),
        ...(endDate && endTime ? { endedAt: fmt.toIso(endDate, endTime) } : {}),
      }),
    onSuccess: () => {
      toast.success(`Trip closed for ${carRegistration}`);
      void qc.invalidateQueries({ queryKey: ['trip', tripId] });
      void qc.invalidateQueries({ queryKey: ['admin-trips'] });
      void qc.invalidateQueries({ queryKey: ['live'] });
      void qc.invalidateQueries({ queryKey: ['bookings'] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (odoError || noteError || timeError) return;
    close.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Close trip"
      description={`Record the end odometer reading for ${carRegistration}. The trip owner is told it was closed by an admin.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="close-trip-form" loading={close.isPending}>
            Close trip
          </Button>
        </>
      }
    >
      <form id="close-trip-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label="End odometer (km)"
          required
          error={submitted ? odoError : null}
          hint={
            reading != null && !odoError
              ? `${(reading - odometerStart).toLocaleString()} km trip (start reading ${odometerStart.toLocaleString()} km)`
              : `Start reading was ${odometerStart.toLocaleString()} km`
          }
        >
          {(p) => <Input {...p} inputMode="numeric" type="number" min={odometerStart} step={1} value={odometer} onChange={(e) => setOdometer(e.target.value)} className="tabular" autoFocus />}
        </Field>
        <Field label="Note" required error={submitted ? noteError : null} hint="For example: “Read from the dashboard by the driver at 17:40”.">
          {(p) => <Textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}
        </Field>
        <Field label="End time (optional)" error={submitted ? timeError : null} hint={defaultEndHint ?? 'Leave blank to use when the car got back to the office, or when it was last seen.'}>
          {(p) => (
            <div className="grid grid-cols-2 gap-2">
              <Input {...p} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-label="End date" />
              <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} aria-label="End time (East Africa Time)" />
            </div>
          )}
        </Field>
      </form>
    </Dialog>
  );
}
