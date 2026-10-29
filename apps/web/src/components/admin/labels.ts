import type { CarStatus, ClientType, DealType, FuelEntryType, FuelType, PropertyService, PropertyStatus, Role } from '@carbooking/core';
import type { Tone } from '@/components/ui/badge';

export const CAR_STATUS: Record<CarStatus, { label: string; tone: Tone }> = {
  AVAILABLE: { label: 'Available', tone: 'success' },
  MAINTENANCE: { label: 'In maintenance', tone: 'warning' },
  RETIRED: { label: 'Retired', tone: 'neutral' },
};

export const FUEL_TYPE_LABELS: Record<FuelType, string> = {
  PETROL: 'Petrol',
  DIESEL: 'Diesel',
  HYBRID: 'Hybrid',
  ELECTRIC: 'Electric',
};

export const CLIENT_TYPE_LABELS: Record<ClientType, string> = {
  VENDOR: 'Vendor',
  LANDLORD: 'Landlord',
  OTHER: 'Other',
};

export const SERVICE_LABELS: Record<PropertyService, string> = {
  SALES: 'Sales',
  LETTINGS: 'Lettings',
  MANAGEMENT: 'Management',
};

export const PROPERTY_STATUS: Record<PropertyStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  SOLD: { label: 'Sold', tone: 'info' },
  LET: { label: 'Let', tone: 'info' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
};

export const DEAL_TYPE_LABELS: Record<DealType, string> = {
  SALE: 'Sale',
  LETTING: 'Letting',
};

export const FUEL_ENTRY_TYPE_LABELS: Record<FuelEntryType, string> = {
  FILL_UP: 'Fill-up',
  MONTHLY: 'Monthly total',
};

export const ROLE_LABELS: Record<Role, string> = {
  STAFF: 'Staff',
  ADMIN: 'Admin',
};

/** Nairobi CBD: where maps start when nothing is set yet. */
export const NAIROBI = { lat: -1.286389, lng: 36.817223 };
