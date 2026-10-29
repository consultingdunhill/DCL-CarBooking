import type { BookingStatus, TrackingStatus } from '@carbooking/core';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const tones = {
  neutral: 'bg-muted text-muted-fg',
  primary: 'bg-accent text-accent-fg',
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-danger',
  info: 'bg-info-bg text-info',
  lost: 'bg-lost-bg text-lost',
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = 'neutral', className, dot, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone], className)} {...props}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {props.children}
    </span>
  );
}

const BOOKING: Record<BookingStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'primary' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  IN_PROGRESS: { label: 'In progress', tone: 'info' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  AWAITING_ODOMETER: { label: 'Needs odometer', tone: 'warning' },
  NO_SHOW: { label: 'No-show', tone: 'danger' },
};

export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const s = BOOKING[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const TRACKING: Record<TrackingStatus, { label: string; tone: Tone }> = {
  NOT_STARTED: { label: 'Not started', tone: 'neutral' },
  LIVE: { label: 'Live', tone: 'success' },
  OFFLINE: { label: 'Offline', tone: 'warning' },
  LOCATION_OFF: { label: 'Location off', tone: 'danger' },
  TRACKING_LOST: { label: 'Tracking lost', tone: 'lost' },
  STOPPED: { label: 'Stopped', tone: 'neutral' },
};

export const trackingTone = (s: TrackingStatus) => TRACKING[s].tone;

export function TrackingBadge({ status, className }: { status: TrackingStatus; className?: string }) {
  const s = TRACKING[status];
  return (
    <Badge tone={s.tone} dot className={className}>
      {s.label}
    </Badge>
  );
}
