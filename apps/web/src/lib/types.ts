// Shapes returned by the API (dates arrive as ISO strings).
import type {
  BookingStatus,
  CarStatus,
  ClientType,
  DealType,
  Department,
  FuelEntryType,
  FuelType,
  ImportRowStatus,
  JoinRequestStatus,
  PropertyService,
  PropertyStatus,
  Role,
  Settings,
  StopStatus,
  TrackingEventType,
  TrackingStatus,
  TripEndMethod,
} from '@carbooking/core';

export type ISODate = string;

export interface Me {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  department: Department | null;
  jobRole: { id: string; name: string } | null;
  privacyAckAt: ISODate | null;
  privacyAckVersion: string | null;
  privacyNoticeVersion: string;
  privacyAckRequired: boolean;
}

export interface UserBrief {
  id: string;
  name: string;
  phone: string | null;
  email?: string;
  department?: Department | null;
}

export interface Office {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  arrivalRadiusM: number;
  wakeupRadiusM: number;
}

export interface Car {
  id: string;
  registration: string;
  make: string;
  model: string;
  color: string | null;
  seats: number | null;
  fuelType: FuelType;
  status: CarStatus;
  currentOdometer: number;
  homeOfficeId: string | null;
  notes: string | null;
}

export interface Driver {
  id: string;
  name: string;
  phone: string;
  active: boolean;
}

export interface VisitReason {
  id: string;
  label: string;
  department: Department;
  countsAsViewing: boolean;
  needsProperty: boolean;
  sortOrder: number;
  active: boolean;
}

export interface Reference {
  office: Office | null;
  cars: Car[];
  reasons: VisitReason[];
  drivers: { id: string; name: string; phone: string }[];
  settings: Pick<Settings, 'currency' | 'timezone' | 'startWindowMin' | 'noShowWindowMin' | 'overdueGraceMin' | 'workingHours' | 'privacyNoticeVersion'>;
  features: { googleRoutes: boolean; authMode: 'dev' | 'entra' };
}

export interface Client {
  id: string;
  name: string;
  type: ClientType;
  phone: string | null;
  email: string | null;
  crmRef: string | null;
  _count?: { properties: number };
}

export interface Property {
  id: string;
  ref: string;
  crmRef: string | null;
  address: string;
  lat: number | null;
  lng: number | null;
  clientId: string | null;
  client: { id: string; name: string; type?: ClientType; phone?: string | null } | null;
  service: PropertyService;
  status: PropertyStatus;
  needsReview: boolean;
  createdBy?: { id: string; name: string } | null;
}

/** A lead in the Dunhill CRM, as much as a booking needs. */
export interface CrmLead {
  ref: string;
  firstName: string;
  serviceType: string;
  serviceLabel: string;
  agent: { name: string; userId: string | null } | null;
  /** directions: the agent's note for the driver (gate, landmark), from the CRM. */
  properties: (Pick<Property, 'id' | 'ref' | 'address' | 'lat' | 'lng' | 'service'> & { title: string; directions: string | null })[];
}

export interface Stop {
  id: string;
  seq: number;
  address: string;
  label: string | null;
  lat: number;
  lng: number;
  status: StopStatus;
  reasonId: string;
  reason: Pick<VisitReason, 'id' | 'label' | 'department' | 'countsAsViewing' | 'needsProperty'>;
  property: { id: string; ref: string; address: string; service?: PropertyService; client: { id: string; name: string } | null } | null;
  addedBy: { id: string; name: string };
  note: string | null;
  joinRequestId: string | null;
  arrivedAt: ISODate | null;
  departedAt: ISODate | null;
  /** The CRM lead this visit is for, when it was booked from the CRM. */
  crmLeadRef: string | null;
  crmLeadName: string | null;
}

export interface TripSummary {
  id: string;
  startedAt: ISODate;
  endedAt: ISODate | null;
  odometerStart: number;
  odometerEnd: number | null;
  unloggedKm: number;
  endMethod: TripEndMethod | null;
  gpsDistanceKm: number | null;
  trackingStatus: TrackingStatus;
  trackingStatusSince: ISODate | null;
  lastLat: number | null;
  lastLng: number | null;
  lastSeenAt: ISODate | null;
  lastBattery: number | null;
  lastAddress: string | null;
  etaAt: ISODate | null;
  officeArrivedAt: ISODate | null;
  awaitingOdometerAt: ISODate | null;
}

export interface JoinRequestBrief {
  id: string;
  status: JoinRequestStatus;
  requester: UserBrief;
  proposedReturnAt: ISODate | null;
  note: string | null;
  createdAt: ISODate;
}

export interface Booking {
  id: string;
  status: BookingStatus;
  startAt: ISODate;
  expectedReturnAt: ISODate;
  notes: string | null;
  /** Flagged urgent by the requester. */
  urgent: boolean;
  /** Set when an admin booked on the owner's behalf. */
  createdBy: { id: string; name: string } | null;
  plannedDistanceKm: number | null;
  plannedDurationMin: number | null;
  plannedPolyline: string | null;
  rejectionReason: string | null;
  cancelReason: string | null;
  decidedAt: ISODate | null;
  createdAt: ISODate;
  ownerId: string;
  carId: string;
  driverId: string;
  owner: UserBrief;
  driver: { id: string; name: string; phone: string };
  car: Pick<Car, 'id' | 'registration' | 'make' | 'model' | 'color' | 'seats' | 'status'>;
  decidedBy: { id: string; name: string } | null;
  stops: Stop[];
  passengers: { user: UserBrief }[];
  joinRequests: JoinRequestBrief[];
  trip: TripSummary | null;
}

export interface Slot {
  bookingId: string;
  status: BookingStatus;
  startAt: ISODate;
  expectedReturnAt: ISODate;
  owner: { id: string; name: string; phone: string | null };
  car: { id: string; registration: string };
  destinations: string[];
  description: string;
  joinable: boolean;
}

export interface Availability {
  bookable: boolean;
  driver: { available: boolean; driverId: string | null; noDriverConfigured: boolean; busyWith: Slot[] };
  cars: { car: Car; available: boolean; reason: 'MAINTENANCE' | 'RETIRED' | 'BOOKED' | null; blocking: Slot[]; tentative: Slot[] }[];
  tentative: Slot[];
}

export interface Conflicts {
  car: Slot[];
  driver: Slot[];
  pendingOverlaps: Slot[];
}

export interface RoutePreview {
  distanceKm: number;
  durationMin: number;
  polyline: string;
  legs: { distanceKm: number; durationMin: number }[];
  source: 'google' | 'estimate';
}

export interface Approvals {
  bookings: (Booking & { conflicts: Conflicts })[];
  joinRequests: {
    id: string;
    status: JoinRequestStatus;
    note: string | null;
    proposedReturnAt: ISODate | null;
    createdAt: ISODate;
    requester: UserBrief;
    booking: Booking;
    stops: (Omit<Stop, 'reason' | 'addedBy' | 'property'> & { reason: VisitReason; property: { id: string; ref: string; address: string } | null })[];
    clash: Conflicts | null;
  }[];
}

export interface TrackingEvent {
  id: string;
  type: TrackingEventType;
  occurredAt: ISODate;
  receivedAt: ISODate;
  source: 'DEVICE' | 'SERVER';
  details: Record<string, unknown> | null;
  lat: number | null;
  lng: number | null;
}

export interface LocationPoint {
  recordedAt: ISODate;
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  battery: number | null;
  isMoving: boolean | null;
}

export interface TripDetail extends TripSummary {
  bookingId: string;
  photoStartKey: string;
  photoEndKey: string | null;
  photoStartUrl: string;
  photoEndUrl: string | null;
  endNote: string | null;
  tripKm: number | null;
  variancePct: number | null;
  varianceThresholdPct: number;
  device: Record<string, unknown> | null;
  booking: Booking;
  events: TrackingEvent[];
  points: LocationPoint[];
}

export interface AdminTripRow extends TripSummary {
  bookingId: string;
  tripKm: number | null;
  variancePct: number | null;
  varianceFlag: boolean;
  issues: number;
  booking: {
    id: string;
    status: BookingStatus;
    startAt: ISODate;
    expectedReturnAt: ISODate;
    owner: { id: string; name: string };
    car: { id: string; registration: string };
    stops: { id: string; address: string; label: string | null }[];
  };
}

export interface TrackingConfig {
  token: string;
  expiresAt: ISODate;
  tripId: string;
  locationsUrl: string;
  eventsUrl: string;
  heartbeatUrl: string;
  office: { lat: number; lng: number; arrivalRadiusM: number; wakeupRadiusM: number };
  stops: { id: string; seq: number; lat: number; lng: number; address: string }[];
  heartbeatIntervalMin: number;
  stopArrivalRadiusM: number;
  officeDwellMin: number;
  endPromptTimeoutMin: number;
  lowBatteryPct: number;
}

export interface LiveSnapshot {
  office: Office;
  cars: (Car & { out: boolean })[];
  trips: {
    bookingId: string;
    status: BookingStatus;
    startAt: ISODate;
    expectedReturnAt: ISODate;
    plannedPolyline: string | null;
    owner: { id: string; name: string; phone: string | null };
    car: { id: string; registration: string; make: string; model: string };
    stops: Pick<Stop, 'id' | 'seq' | 'address' | 'label' | 'lat' | 'lng' | 'status' | 'arrivedAt' | 'departedAt'>[];
    passengers: { id: string; name: string }[];
    trip: (TripSummary & { bookingId: string }) | null;
  }[];
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: ISODate | null;
  createdAt: ISODate;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  department: Department | null;
  active: boolean;
  lastLoginAt: ISODate | null;
  privacyAckAt: ISODate | null;
  entraOid: string | null;
  jobRole: { id: string; name: string } | null;
}

export interface JobRole {
  id: string;
  name: string;
  active: boolean;
  _count?: { users: number };
}

export interface HourlyRate {
  id: string;
  jobRoleId: string | null;
  forDriver: boolean;
  rate: number;
  effectiveFrom: ISODate;
  jobRole: { id: string; name: string } | null;
}

export interface FuelEntry {
  id: string;
  carId: string;
  type: FuelEntryType;
  date: ISODate;
  litres: number;
  amount: number;
  currency: string;
  odometer: number | null;
  receiptKey: string | null;
  notes: string | null;
  car?: { registration: string };
  enteredBy?: { name: string };
}

export interface Closure {
  id: string;
  propertyId: string;
  staffId: string | null;
  closedAt: ISODate;
  dealType: DealType;
  fee: number | null;
  crmRef: string | null;
  property: { id: string; ref: string; address: string };
  staff: { id: string; name: string } | null;
}

export interface ClosureImportBatch {
  id: string;
  fileName: string;
  uploadedAt: ISODate;
  rowCount: number;
  matchedCount: number;
  unmatchedCount: number;
  duplicateCount: number;
  uploadedBy?: { name: string };
}

export interface ClosureImportRow {
  id: string;
  rowNumber: number;
  raw: Record<string, string>;
  status: ImportRowStatus;
  problems: string[];
  batch: { fileName: string; uploadedAt: ISODate };
}

export interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  at: ISODate;
  actor: { id: string; name: string } | null;
}
