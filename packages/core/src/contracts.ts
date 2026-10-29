// Request schemas shared by the API (validation) and the web app (forms).
import { z } from 'zod';
import {
  CAR_STATUSES,
  CLIENT_TYPES,
  DEPARTMENTS,
  FUEL_ENTRY_TYPES,
  FUEL_TYPES,
  PROPERTY_SERVICES,
  PROPERTY_STATUSES,
  DEAL_TYPES,
  ROLES,
} from './enums';
import { REPORT_IDS } from './reports';
import { SettingsSchema } from './settings';

export const id = z.uuid();
export const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
export const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const phone = z
  .string()
  .trim()
  .max(30)
  .regex(/^\+?[0-9 ()-]{7,}$/, 'Enter a valid phone number');

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// ── Bookings ──────────────────────────────────────────────────────────────────

export const StopInputSchema = LatLngSchema.extend({
  propertyId: id.nullish(),
  placeId: optText(300),
  label: optText(200),
  address: z.string().trim().min(1).max(500),
  reasonId: id,
  note: optText(1000),
  /** Set when the stop was booked from a CRM lead: their id there and first name. */
  crmLeadRef: optText(40),
  crmLeadName: optText(80),
});
export type StopInput = z.infer<typeof StopInputSchema>;

export const CreateBookingSchema = z.object({
  carId: id,
  startAt: isoDate,
  expectedReturnAt: isoDate,
  stops: z.array(StopInputSchema).min(1).max(12),
  notes: optText(2000),
  /** Every admin is alerted by push and SMS/WhatsApp; still needs approval. */
  urgent: z.boolean().default(false),
  /** Admins only: book on a staff member's behalf (approved straight away). */
  ownerId: id.optional(),
});
export type CreateBookingInput = z.input<typeof CreateBookingSchema>;

export const AvailabilityQuerySchema = z.object({
  start: isoDate,
  end: isoDate,
  excludeBookingId: id.optional(),
});

export const ApproveBookingSchema = z.object({
  carId: id.optional(),
  driverId: id.optional(),
  note: optText(1000),
});

export const RejectSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason').max(1000),
});

export const CancelSchema = z.object({
  reason: optText(1000),
});

export const JoinRequestSchema = z.object({
  stops: z.array(StopInputSchema).min(1).max(6),
  proposedReturnAt: isoDate.optional(),
  note: optText(1000),
});
export type JoinRequestInput = z.input<typeof JoinRequestSchema>;

export const RoutePreviewSchema = z.object({
  origin: LatLngSchema,
  stops: z.array(LatLngSchema).min(1).max(12),
  returnToOrigin: z.boolean().default(true),
});

export const BookingListQuerySchema = z.object({
  scope: z.enum(['mine', 'all', 'calendar', 'approvals']).default('mine'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.string().optional(),
});

// ── Uploads ───────────────────────────────────────────────────────────────────

export const UPLOAD_KINDS = ['ODOMETER_START', 'ODOMETER_END', 'RECEIPT', 'IMPORT'] as const;
export const UploadRequestSchema = z.object({
  kind: z.enum(UPLOAD_KINDS),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']),
});

// ── Trips ─────────────────────────────────────────────────────────────────────

const odometer = z.number().int('Whole km only').min(0).max(2_000_000);

export const DeviceInfoSchema = z
  .object({
    platform: z.string().max(20),
    model: z.string().max(100),
    os: z.string().max(50),
    appVersion: z.string().max(30),
  })
  .partial();

export const StartTripSchema = z.object({
  odometer,
  photoKey: z.string().min(1).max(300),
  /** Idempotency key generated on the device, so an offline retry doesn't start twice. */
  clientRequestId: z.string().min(8).max(100),
  /** Device time of the tap, when the request was queued offline. */
  startedAt: isoDate.optional(),
  device: DeviceInfoSchema.optional(),
});

export const EndTripSchema = z.object({
  odometer,
  photoKey: z.string().min(1).max(300),
  clientRequestId: z.string().min(8).max(100),
  endedAt: isoDate.optional(),
  method: z.enum(['MANUAL', 'GEOFENCE']).default('MANUAL'),
});

export const AdminCloseTripSchema = z.object({
  odometer,
  note: z.string().trim().min(3, 'Say how the reading was obtained').max(1000),
  photoKey: z.string().max(300).optional(),
  endedAt: isoDate.optional(),
});

/** A stop added or changed by the trip owner while the trip is running. */
export const TripStopSchema = StopInputSchema;

export const ExtendEtaSchema = z.object({
  expectedReturnAt: isoDate,
});

export const StopActionSchema = z.object({
  action: z.enum(['ARRIVED', 'DEPARTED', 'SKIPPED']),
  at: isoDate.optional(),
});

/** A location as posted by the Transistorsoft background geolocation plugin. */
export const DeviceLocationSchema = z.looseObject({
  uuid: z.string().max(100).optional(),
  timestamp: z.string(),
  is_moving: z.boolean().optional(),
  event: z.string().optional(),
  coords: z.looseObject({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().optional(),
    speed: z.number().optional(),
    heading: z.number().optional(),
    altitude: z.number().optional(),
  }),
  battery: z.looseObject({ level: z.number().optional(), is_charging: z.boolean().optional() }).optional(),
  activity: z.looseObject({ type: z.string().optional() }).optional(),
  extras: z.record(z.string(), z.unknown()).optional(),
});
export type DeviceLocation = z.infer<typeof DeviceLocationSchema>;

export const LocationBatchSchema = z.object({
  location: z.union([DeviceLocationSchema, z.array(DeviceLocationSchema).max(1000)]),
});

/** Events the device itself reports. Server-only events are excluded. */
export const DEVICE_EVENT_TYPES = [
  'LOCATION_OFF',
  'LOCATION_ON',
  'PERMISSION_CHANGED',
  'OFFLINE',
  'ONLINE',
  'AIRPLANE_MODE_ON',
  'AIRPLANE_MODE_OFF',
  'GEOFENCE_ENTER',
  'GEOFENCE_EXIT',
  'LOW_BATTERY',
] as const;

export const DeviceEventBatchSchema = z.object({
  events: z
    .array(
      z.object({
        clientEventId: z.string().min(8).max(100),
        type: z.enum(DEVICE_EVENT_TYPES),
        occurredAt: isoDate,
        details: z.record(z.string(), z.unknown()).optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
        battery: z.number().min(0).max(100).optional(),
      }),
    )
    .min(1)
    .max(500),
});

// ── Admin: resources ──────────────────────────────────────────────────────────

export const CarSchema = z.object({
  registration: z
    .string()
    .trim()
    .min(2)
    .max(20)
    .transform((s) => s.toUpperCase().replace(/\s+/g, ' ')),
  make: z.string().trim().min(1).max(50),
  model: z.string().trim().min(1).max(50),
  color: optText(30),
  seats: z.number().int().min(1).max(20).nullish(),
  fuelType: z.enum(FUEL_TYPES),
  status: z.enum(CAR_STATUSES).default('AVAILABLE'),
  currentOdometer: odometer,
  homeOfficeId: id.nullish(),
  notes: optText(1000),
});

export const DriverSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone,
  active: z.boolean().default(true),
});

export const VisitReasonSchema = z.object({
  label: z.string().trim().min(2).max(80),
  department: z.enum(DEPARTMENTS),
  countsAsViewing: z.boolean().default(false),
  needsProperty: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().default(true),
});

export const ReorderSchema = z.object({ ids: z.array(id).min(1) });

export const ClientSchema = z.object({
  name: z.string().trim().min(2).max(150),
  type: z.enum(CLIENT_TYPES),
  phone: phone.nullish().or(z.literal('').transform(() => null)),
  email: z.email().nullish().or(z.literal('').transform(() => null)),
  crmRef: optText(100),
});

export const PropertySchema = z.object({
  ref: z.string().trim().min(1).max(50),
  crmRef: optText(100),
  address: z.string().trim().min(3).max(500),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  clientId: id.nullish(),
  service: z.enum(PROPERTY_SERVICES),
  status: z.enum(PROPERTY_STATUSES).default('ACTIVE'),
  /** Create the client on the spot (staff adding a property while booking). */
  newClient: ClientSchema.optional(),
});

export const JobRoleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  active: z.boolean().default(true),
});

export const HourlyRateSchema = z
  .object({
    jobRoleId: id.nullish(),
    forDriver: z.boolean().default(false),
    rate: z.number().min(0).max(1_000_000),
    effectiveFrom: dateKey,
  })
  .refine((r) => r.forDriver !== Boolean(r.jobRoleId), 'Choose either a job role or the driver');

export const FuelEntrySchema = z.object({
  carId: id,
  type: z.enum(FUEL_ENTRY_TYPES).default('FILL_UP'),
  date: dateKey,
  litres: z.number().positive('Litres are required to work out km/L').max(10_000),
  amount: z.number().positive().max(100_000_000),
  currency: z.string().length(3).optional(),
  odometer: odometer.nullish(),
  receiptKey: z.string().max(300).nullish(),
  notes: optText(1000),
});

export const OfficeSchema = LatLngSchema.extend({
  name: z.string().trim().min(2).max(100),
  address: z.string().trim().min(3).max(500),
  arrivalRadiusM: z.number().int().min(5).max(500).default(20),
  wakeupRadiusM: z.number().int().min(100).max(2000).default(150),
});

export const UserUpdateSchema = z.object({
  phone: phone.nullish(),
  department: z.enum(DEPARTMENTS).nullish(),
  jobRoleId: id.nullish(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
});

export const MeUpdateSchema = z.object({
  phone: phone.nullish(),
  department: z.enum(DEPARTMENTS).nullish(),
});

export const SettingsUpdateSchema = SettingsSchema.partial();

export const ResolveClosureRowSchema = z.union([
  z.object({
    propertyId: id,
    staffId: id,
    closedAt: dateKey.optional(),
    dealType: z.enum(DEAL_TYPES).optional(),
    fee: z.number().min(0).nullish(),
  }),
  z.object({ ignore: z.literal(true) }),
]);

export const PushSubscriptionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('WEB'),
    endpoint: z.url(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  }),
  z.object({
    kind: z.literal('FCM'),
    token: z.string().min(10),
    platform: z.enum(['ios', 'android']),
  }),
]);

export const ReportQuerySchema = z.object({
  from: dateKey,
  to: dateKey,
  carId: id.optional(),
  staffId: id.optional(),
  department: z.enum(DEPARTMENTS).optional(),
  reasonId: id.optional(),
  propertyId: id.optional(),
  clientId: id.optional(),
  groupBy: z.string().max(30).optional(),
  format: z.enum(['json', 'csv', 'xlsx']).default('json'),
});

export const ReportIdSchema = z.enum(REPORT_IDS);
