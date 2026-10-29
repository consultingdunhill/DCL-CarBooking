// String unions mirroring the Prisma enums in packages/db, so the web app can
// use them without depending on the Prisma client.

export const ROLES = ['STAFF', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const DEPARTMENTS = ['SALES', 'LETTINGS', 'PROPERTY_MANAGEMENT', 'OTHER'] as const;
export type Department = (typeof DEPARTMENTS)[number];
export const DEPARTMENT_LABELS: Record<Department, string> = {
  SALES: 'Sales',
  LETTINGS: 'Lettings',
  PROPERTY_MANAGEMENT: 'Property Management',
  OTHER: 'Other',
};

export const CAR_STATUSES = ['AVAILABLE', 'MAINTENANCE', 'RETIRED'] as const;
export type CarStatus = (typeof CAR_STATUSES)[number];

export const FUEL_TYPES = ['PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC'] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const BOOKING_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'IN_PROGRESS',
  'COMPLETED',
  'AWAITING_ODOMETER',
  'NO_SHOW',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const STOP_STATUSES = ['PROPOSED', 'PLANNED', 'ARRIVED', 'DEPARTED', 'SKIPPED', 'REJECTED'] as const;
export type StopStatus = (typeof STOP_STATUSES)[number];

export const JOIN_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const TRACKING_STATUSES = ['NOT_STARTED', 'LIVE', 'OFFLINE', 'LOCATION_OFF', 'TRACKING_LOST', 'STOPPED'] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export const TRIP_END_METHODS = ['MANUAL', 'GEOFENCE', 'ADMIN'] as const;
export type TripEndMethod = (typeof TRIP_END_METHODS)[number];

export const TRACKING_EVENT_TYPES = [
  'TRIP_STARTED',
  'TRIP_ENDED',
  'LOCATION_OFF',
  'LOCATION_ON',
  'PERMISSION_CHANGED',
  'OFFLINE',
  'ONLINE',
  'AIRPLANE_MODE_ON',
  'AIRPLANE_MODE_OFF',
  'HEARTBEAT_MISSED',
  'TRACKING_LOST',
  'TRACKING_RESUMED',
  'GEOFENCE_ENTER',
  'GEOFENCE_EXIT',
  'OFFICE_ARRIVED',
  'STOP_ARRIVED',
  'STOP_DEPARTED',
  'STOP_ADDED',
  'STOP_CHANGED',
  'OVERDUE',
  'ETA_EXTENDED',
  'LOW_BATTERY',
  'AWAITING_ODOMETER',
] as const;
export type TrackingEventType = (typeof TRACKING_EVENT_TYPES)[number];

export const EVENT_SOURCES = ['DEVICE', 'SERVER'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const CLIENT_TYPES = ['VENDOR', 'LANDLORD', 'OTHER'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const PROPERTY_SERVICES = ['SALES', 'LETTINGS', 'MANAGEMENT'] as const;
export type PropertyService = (typeof PROPERTY_SERVICES)[number];

export const PROPERTY_STATUSES = ['ACTIVE', 'SOLD', 'LET', 'WITHDRAWN'] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

export const DEAL_TYPES = ['SALE', 'LETTING'] as const;
export type DealType = (typeof DEAL_TYPES)[number];

export const IMPORT_ROW_STATUSES = ['MATCHED', 'UNMATCHED', 'RESOLVED', 'IGNORED', 'DUPLICATE'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const FUEL_ENTRY_TYPES = ['FILL_UP', 'MONTHLY'] as const;
export type FuelEntryType = (typeof FUEL_ENTRY_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['IN_APP', 'PUSH', 'EMAIL', 'SMS', 'WHATSAPP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const STOP_COST_SPLITS = ['EQUAL', 'DWELL_TIME'] as const;
export type StopCostSplit = (typeof STOP_COST_SPLITS)[number];
