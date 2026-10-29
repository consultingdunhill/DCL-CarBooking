import { z } from 'zod';
import { STOP_COST_SPLITS } from './enums';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

/** Working hours per weekday, index 0 = Sunday … 6 = Saturday. */
export const WorkingHoursSchema = z
  .array(z.array(z.tuple([hhmm, hhmm])))
  .length(7);
export type WorkingHours = z.infer<typeof WorkingHoursSchema>;

export const SettingsSchema = z.object({
  currency: z.string().length(3),
  timezone: z.string().min(1),
  workingHours: WorkingHoursSchema,
  /** Minutes after the expected return before a trip counts as overdue. */
  overdueGraceMin: z.number().int().min(0).max(240),
  /** Minutes after the booked start before an unstarted booking becomes a no-show. */
  noShowWindowMin: z.number().int().min(5).max(240),
  /** How early (minutes) the trip owner may start the trip. */
  startWindowMin: z.number().int().min(0).max(240),
  /** Expected heartbeat interval while stationary. */
  heartbeatIntervalMin: z.number().int().min(1).max(60),
  /** No contact for longer than this → "Offline since…". */
  offlineThresholdMin: z.number().int().min(1).max(120),
  /** No contact for longer than this → "Tracking lost". */
  trackingLostThresholdMin: z.number().int().min(2).max(720),
  /** Battery at or below this with no contact → tracking lost straight away. */
  deadBatteryPct: z.number().int().min(0).max(50),
  lowBatteryPct: z.number().int().min(0).max(100),
  /** Minutes the end-trip prompt waits before the trip moves to AWAITING_ODOMETER. */
  endPromptTimeoutMin: z.number().int().min(1).max(240),
  /** Interval between AWAITING_ODOMETER reminders. */
  awaitingOdometerReminderMin: z.number().int().min(5).max(1440),
  stopArrivalRadiusM: z.number().int().min(10).max(500),
  stopDwellMin: z.number().min(0.5).max(30),
  officeDwellMin: z.number().min(0.5).max(30),
  /** GPS fixes with a worse reported accuracy are ignored for distance and zones. */
  maxFixAccuracyM: z.number().int().min(10).max(500),
  odometerVarianceThresholdPct: z.number().min(1).max(100),
  gpsRetentionMonths: z.number().int().min(1).max(120),
  /** How a trip's fuel and travel time are shared across its stops. On hold with the business. */
  stopCostSplit: z.enum(STOP_COST_SPLITS),
  /** Properties with at least this many viewings and no closure are flagged. */
  manyViewingsThreshold: z.number().int().min(1).max(100),
  privacyNoticeVersion: z.string().min(1),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  currency: 'KES',
  timezone: 'Africa/Nairobi',
  workingHours: [
    [],
    [['08:00', '18:00']],
    [['08:00', '18:00']],
    [['08:00', '18:00']],
    [['08:00', '18:00']],
    [['08:00', '18:00']],
    [['09:00', '13:00']],
  ],
  overdueGraceMin: 15,
  noShowWindowMin: 30,
  startWindowMin: 30,
  heartbeatIntervalMin: 5,
  offlineThresholdMin: 5,
  trackingLostThresholdMin: 30,
  deadBatteryPct: 5,
  lowBatteryPct: 15,
  endPromptTimeoutMin: 15,
  awaitingOdometerReminderMin: 60,
  stopArrivalRadiusM: 50,
  stopDwellMin: 2,
  officeDwellMin: 2,
  maxFixAccuracyM: 75,
  odometerVarianceThresholdPct: 15,
  gpsRetentionMonths: 12,
  stopCostSplit: 'EQUAL',
  manyViewingsThreshold: 5,
  privacyNoticeVersion: '2026-10',
};

export type SettingKey = keyof Settings;

/** Merge stored key/value rows over the defaults, ignoring unknown or invalid values. */
export function resolveSettings(rows: { key: string; value: unknown }[]): Settings {
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in DEFAULT_SETTINGS) merged[row.key] = row.value;
  }
  const parsed = SettingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Fall back key by key so one bad value doesn't discard every other setting.
  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const shape = SettingsSchema.shape as Record<string, z.ZodType>;
  for (const row of rows) {
    const field = shape[row.key];
    if (field && field.safeParse(row.value).success) result[row.key] = row.value;
  }
  return result as Settings;
}
