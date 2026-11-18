/**
 * The ERPNext doctypes Fleet copies into, built from Fleet's own enums.
 *
 * ERPNext rejects a Select value that isn't one of the field's options, and Data longer
 * than its column, so the doctypes are defined here, next to the sync that fills them.
 * `pnpm erp:schema --out DIR` writes them as JSON for the dunhill-erp repo, whose
 * provision.py puts them on the ERP site.
 *
 * The copy is read-only for people: only the sync user ("Dunhill Integration") writes, and
 * every field is read-only as well. Costs sit on permission level 1, which only Fleet
 * Managers (and System Managers) can read, as in Fleet, where costs are admin-only.
 */
import {
  BOOKING_STATUSES,
  CAR_STATUSES,
  FUEL_ENTRY_TYPES,
  FUEL_TYPES,
  STOP_STATUSES,
  TRACKING_STATUSES,
  TRIP_END_METHODS,
} from '@carbooking/core';

export const MODULE = 'Dunhill Fleet';
export const READERS = ['Fleet User', 'Fleet Manager', 'System Manager'] as const;
export const MANAGERS = ['Fleet Manager', 'System Manager'] as const;
export const WRITER = 'Dunhill Integration';
/** ERPNext's Data column is varchar(140) unless a field sets its own length. */
export const DATA_DEFAULT_LENGTH = 140;

export const CAR = 'Fleet Car';
export const BOOKING = 'Fleet Booking';
export const STOP = 'Fleet Booking Stop';
export const FUEL = 'Fleet Fuel Entry';
export const CAR_MONTH = 'Fleet Car Month';
export const SYNC_STATUS = 'Fleet Sync Status';
/** The CRM's copy, already in ERPNext (the CRM's app/services/erp_schema.py). */
export const CRM_LISTING = 'DC Listing';
export const CRM_LEAD = 'DC Lead';

/**
 * Every flag of a permission row. ERPNext turns an omitted flag ON (DocPerm defaults), so
 * each row states all of them; a row that left "write" out would hand that role write access.
 */
export const PERMISSION_FLAGS = [
  'select', 'read', 'write', 'create', 'delete', 'submit', 'cancel', 'amend',
  'report', 'export', 'import', 'set_user_permissions', 'share', 'print', 'email',
] as const;

const LABEL_OVERRIDES: Record<string, string> = {
  AWAITING_ODOMETER: 'Waiting for odometer reading',
  NO_SHOW: 'No-show',
  FILL_UP: 'Fill-up',
  MONTHLY: 'Monthly total',
  GEOFENCE: 'Arrived back (geofence)',
  ADMIN: 'Closed by an admin',
  MANUAL: 'Ended by the trip owner',
};

/** The words staff see for an enum value. */
export function label(value: string | null | undefined): string {
  if (!value) return '';
  return LABEL_OVERRIDES[value] ?? value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ');
}

function options(values: readonly string[]): string {
  return ['', ...values.map(label)].join('\n');
}

export interface Field {
  fieldname: string;
  fieldtype: string;
  label: string;
  options?: string;
  length?: number;
  read_only?: number;
  permlevel?: number;
  [key: string]: unknown;
}
export interface DocTypeDef {
  doctype: 'DocType';
  name: string;
  module: string;
  custom: 1;
  fields: Field[];
  permissions?: Record<string, unknown>[];
  [key: string]: unknown;
}

const BREAKS = new Set(['Section Break', 'Column Break', 'Tab Break']);

function f(fieldname: string, fieldtype: string, label_: string, extra: Partial<Field> = {}): Field {
  const field: Field = { fieldname, fieldtype, label: label_ };
  if (!BREAKS.has(fieldtype)) field.read_only = 1;
  return { ...field, ...extra };
}
const data = (fieldname: string, label_: string, length?: number, extra: Partial<Field> = {}) =>
  f(fieldname, 'Data', label_, length && length !== DATA_DEFAULT_LENGTH ? { length, ...extra } : extra);
const select = (fieldname: string, label_: string, values: readonly string[], extra: Partial<Field> = {}) =>
  f(fieldname, 'Select', label_, { options: options(values), ...extra });
const section = (fieldname: string, label_ = '', extra: Partial<Field> = {}) => f(fieldname, 'Section Break', label_, extra);
const column = (fieldname: string) => f(fieldname, 'Column Break', '');
const cost = (fieldname: string, label_: string, extra: Partial<Field> = {}) =>
  f(fieldname, 'Currency', label_, { permlevel: 1, ...extra });

function permission(role: string, granted: Partial<Record<(typeof PERMISSION_FLAGS)[number], number>>, permlevel = 0, single = false) {
  const g = { ...granted };
  if (single) {
    // not offered on a single-record doctype
    delete g.report;
    delete g.export;
    delete g.import;
  }
  return { role, permlevel, if_owner: 0, ...Object.fromEntries(PERMISSION_FLAGS.map((flag) => [flag, g[flag] ?? 0])) };
}

function permissions(readers: readonly string[], opts: { single?: boolean; costs?: boolean } = {}) {
  const rows = [
    ...readers.map((r) => permission(r, { read: 1, report: 1, export: 1, print: 1 }, 0, opts.single)),
    permission(WRITER, { read: 1, write: 1, create: 1, delete: 1, report: 1 }, 0, opts.single),
  ];
  if (opts.costs) {
    // Level 1 carries only read and write in ERPNext.
    rows.push(...MANAGERS.map((r) => permission(r, { read: 1 }, 1)), permission(WRITER, { read: 1, write: 1 }, 1));
  }
  return rows;
}

function doctype(name: string, fields: Field[], extra: Record<string, unknown> & { istable?: boolean; issingle?: boolean; readers?: readonly string[]; costs?: boolean } = {}): DocTypeDef {
  const { istable, issingle, readers = READERS, costs, ...rest } = extra;
  const doc: DocTypeDef = { doctype: 'DocType', name, module: MODULE, custom: 1, fields, track_changes: 0 };
  if (istable) Object.assign(doc, { istable: 1, editable_grid: 0 });
  else if (issingle) Object.assign(doc, { issingle: 1, permissions: permissions(readers, { single: true }) });
  else {
    Object.assign(doc, {
      // "User cannot create": hides "+ Add" for everyone; the sync still creates through the API.
      in_create: 1,
      autoname: 'field:fleet_ref',
      naming_rule: 'By fieldname',
      sort_field: 'creation',
      sort_order: 'DESC',
      permissions: permissions(readers, { costs }),
    });
  }
  return Object.assign(doc, rest);
}

const fleetRef = (label_: string) => data('fleet_ref', label_, undefined, { unique: 1, reqd: 1 });
const fleetFields = () => [
  section('fleet_section', 'Fleet', { collapsible: 1 }),
  data('fleet_url', 'Open in Fleet', 300, { options: 'URL' }),
  column('fleet_column'),
  f('updated_in_fleet', 'Datetime', 'Last changed in Fleet'),
];

export function carDoctype(): DocTypeDef {
  return doctype(
    CAR,
    [
      fleetRef('Car reference'),
      data('registration', 'Registration', 20, { bold: 1, in_list_view: 1, reqd: 1 }),
      data('make', 'Make', 60, { in_list_view: 1 }),
      data('model', 'Model', 60, { in_list_view: 1 }),
      data('color', 'Colour', 40),
      f('seats', 'Int', 'Seats', { depends_on: 'eval:doc.seats' }),
      column('car_column'),
      select('status', 'Status', CAR_STATUSES, { in_list_view: 1, in_standard_filter: 1 }),
      select('fuel_type', 'Fuel', FUEL_TYPES),
      f('odometer', 'Int', 'Odometer (km)'),
      f('has_tracker', 'Check', 'Has a GPS tracker'),
      f('notes', 'Small Text', 'Notes'),
      ...fleetFields(),
    ],
    { title_field: 'registration', show_title_field_in_link: 1, search_fields: 'make,model' },
  );
}

export function stopDoctype(): DocTypeDef {
  return doctype(
    STOP,
    [
      f('seq', 'Int', 'Order'),
      data('place', 'Place', 300, { in_list_view: 1 }),
      f('listing', 'Link', 'CRM listing', { options: CRM_LISTING }),
      f('lead', 'Link', 'CRM lead', { options: CRM_LEAD }),
      data('lead_name', 'Lead', 160, { in_list_view: 1 }),
      data('reason', 'Reason', 120, { in_list_view: 1 }),
      f('counts_as_viewing', 'Check', 'A viewing'),
      select('status', 'Status', STOP_STATUSES, { in_list_view: 1 }),
      f('arrived_at', 'Datetime', 'Arrived'),
      f('departed_at', 'Datetime', 'Left'),
      f('dwell_hours', 'Float', 'Hours there', { permlevel: 1, precision: '2' }),
      cost('stop_cost', "This stop's cost", { in_list_view: 1 }),
    ],
    { istable: true },
  );
}

export function bookingDoctype(): DocTypeDef {
  return doctype(
    BOOKING,
    [
      f('booking_tab', 'Tab Break', 'Booking'),
      fleetRef('Booking reference'),
      data('title', 'Booking', 200, { bold: 1 }),
      select('status', 'Status', BOOKING_STATUSES, { in_list_view: 1, in_standard_filter: 1 }),
      f('starts_at', 'Datetime', 'Starts', { in_list_view: 1 }),
      f('returns_at', 'Datetime', 'Expected back'),
      data('booked_by', 'Booked by', 120, { in_list_view: 1, in_standard_filter: 1 }),
      data('booked_by_email', "Booker's email", 160),
      f('passengers', 'Small Text', 'Also on the trip'),
      column('booking_column'),
      f('car', 'Link', 'Car', { options: CAR, in_standard_filter: 1 }),
      data('car_registration', 'Registration', 20, { in_list_view: 1 }),
      data('driver', 'Driver', 120),
      data('reason', 'Reason', 120),
      f('urgent', 'Check', 'Urgent'),
      f('planned_km', 'Float', 'Planned km', { depends_on: 'eval:doc.planned_km', precision: '1' }),
      f('planned_minutes', 'Int', 'Planned minutes', { depends_on: 'eval:doc.planned_minutes' }),
      section('decision_section', 'Decision', { collapsible: 1 }),
      data('booked_for_them_by', 'Booked for them by', 120),
      data('decided_by', 'Decided by', 120),
      f('decided_at', 'Datetime', 'Decided'),
      f('rejection_reason', 'Small Text', 'Why it was rejected'),
      column('cancel_column'),
      f('cancelled_at', 'Datetime', 'Cancelled'),
      f('cancel_reason', 'Small Text', 'Why it was cancelled'),
      f('notes', 'Small Text', 'Notes'),
      f('stops_tab', 'Tab Break', 'Stops'),
      f('stops', 'Table', 'Stops', { options: STOP }),
      // ERPNext stores an empty number as 0, so trip and cost show only once there is a trip.
      f('trip_tab', 'Tab Break', 'Trip', { depends_on: 'eval:doc.trip_started_at' }),
      f('trip_started_at', 'Datetime', 'Started'),
      f('trip_ended_at', 'Datetime', 'Ended'),
      select('end_method', 'How it ended', TRIP_END_METHODS),
      select('tracking_status', 'Tracking', TRACKING_STATUSES),
      column('odometer_column'),
      f('odometer_start', 'Int', 'Odometer at start'),
      f('odometer_end', 'Int', 'Odometer at end'),
      f('trip_km', 'Float', 'Km (odometer)', { precision: '1' }),
      f('unlogged_km', 'Int', 'Km driven between trips', { depends_on: 'eval:doc.unlogged_km' }),
      f('gps_km', 'Float', 'Km (GPS)', { depends_on: 'eval:doc.gps_km', precision: '1' }),
      section('cost_section', 'Cost', { depends_on: 'eval:doc.trip_ended_at' }),
      cost('fuel_cost', 'Fuel'),
      cost('time_cost', "People's time"),
      cost('total_cost', 'Total', { bold: 1 }),
      column('cost_column'),
      cost('cost_per_km', 'Cost per km used'),
      f('cost_note', 'Small Text', 'How it was worked out', { permlevel: 1 }),
      ...fleetFields(),
    ],
    {
      costs: true,
      title_field: 'title',
      show_title_field_in_link: 1,
      search_fields: 'booked_by,car_registration',
      sort_field: 'starts_at',
    },
  );
}

export function fuelDoctype(): DocTypeDef {
  return doctype(
    FUEL,
    [
      fleetRef('Fuel entry reference'),
      f('car', 'Link', 'Car', { options: CAR, in_standard_filter: 1 }),
      data('car_registration', 'Registration', 20, { in_list_view: 1 }),
      f('date', 'Date', 'Date', { in_list_view: 1 }),
      select('entry_type', 'Entry', FUEL_ENTRY_TYPES),
      column('fuel_column'),
      f('litres', 'Float', 'Litres', { in_list_view: 1, precision: '2' }),
      f('amount', 'Currency', 'Amount', { in_list_view: 1 }),
      f('odometer', 'Int', 'Odometer (km)', { depends_on: 'eval:doc.odometer' }),
      data('entered_by', 'Entered by', 120),
      f('notes', 'Small Text', 'Notes'),
      ...fleetFields(),
    ],
    { readers: MANAGERS, title_field: 'car_registration', sort_field: 'date' },
  );
}

export function carMonthDoctype(): DocTypeDef {
  return doctype(
    CAR_MONTH,
    [
      fleetRef('Reference'),
      f('car', 'Link', 'Car', { options: CAR, in_standard_filter: 1 }),
      data('car_registration', 'Registration', 20, { in_list_view: 1 }),
      data('month', 'Month', 7, { in_list_view: 1, in_standard_filter: 1 }),
      f('km', 'Float', 'Km', { in_list_view: 1, precision: '1' }),
      f('trip_km', 'Float', 'On trips', { precision: '1' }),
      f('unlogged_km', 'Float', 'Between trips', { precision: '1' }),
      column('fuel_column'),
      f('litres', 'Float', 'Litres', { precision: '2' }),
      f('fuel_cost', 'Currency', 'Fuel spend', { in_list_view: 1 }),
      f('km_per_litre', 'Float', 'Km per litre', { in_list_view: 1, precision: '2' }),
      f('litres_per_100km', 'Float', 'Litres per 100 km', { precision: '2' }),
      f('cost_per_km', 'Currency', 'Cost per km'),
      section('rolling_section', 'Last three months', { collapsible: 1 }),
      f('rolling_km_per_litre', 'Float', 'Km per litre', { precision: '2' }),
      column('rolling_column'),
      f('rolling_cost_per_km', 'Currency', 'Cost per km'),
      ...fleetFields(),
    ],
    { readers: MANAGERS, title_field: 'car_registration', sort_field: 'month' },
  );
}

export function syncStatusDoctype(): DocTypeDef {
  return doctype(
    SYNC_STATUS,
    [
      f('synced_at', 'Datetime', 'Last synced with Fleet'),
      f('sent', 'Int', 'Records sent in that run'),
      f('failing_records', 'Int', "Records that couldn't be copied"),
      f('first_failure', 'Small Text', 'First problem'),
      f('interval_minutes', 'Int', 'Runs every (minutes)'),
      data('fleet_url', 'Fleet admin', 300, { options: 'URL' }),
    ],
    { issingle: true },
  );
}

/** In the order ERPNext needs them: a doctype exists before anything links to it. */
export function allDoctypes(): DocTypeDef[] {
  return [carDoctype(), stopDoctype(), bookingDoctype(), fuelDoctype(), carMonthDoctype(), syncStatusDoctype()];
}

/** fieldname -> field, for one doctype. */
export function fieldsOf(name: string): Map<string, Field> {
  const def = allDoctypes().find((d) => d.name === name);
  if (!def) throw new Error(`unknown doctype ${name}`);
  return new Map(def.fields.filter((x) => !BREAKS.has(x.fieldtype)).map((x) => [x.fieldname, x]));
}
