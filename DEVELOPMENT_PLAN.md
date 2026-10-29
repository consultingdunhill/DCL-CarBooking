# Company Car Booking & Trip Tracking App — High-Level Development Plan

We will build one React codebase, shipped as a web app/PWA for booking and admin and as a Capacitor iOS/Android app that staff use for tracked trips. Version 1 covers booking, approval, live tracking, fuel reports and the cost of every viewing, property and client, and takes roughly **14–20 weeks** with 2 full-stack developers.

## 1. Context

We are a real estate company in Kenya covering sales, lettings and property management. We run a small pool of company cars (1–5 cars, one office), and **one company driver drives every trip**. We want an app that:

- Lets **staff** request a trip, with an Uber-style map experience
- Lets **admins** approve, reject or reassign requests
- Tracks each trip live from the start odometer reading until the car is back at the office
- Tells the admin when tracking is interrupted (location turned off, data off, phone dead)
- Produces **cost and efficiency reports** covering fuel efficiency (km/L), cost per km, the cost of each viewing, the hidden time and fuel cost of each property and client, and which staff close deals most effectively

The main business goal is to understand **what the cars cost, how efficiently they are used, and whether the viewings they make possible are worth it**.

### Confirmed decisions

| Topic | Decision |
|---|---|
| Platforms | Web app / PWA for booking and admin, plus a **native iOS/Android app (Capacitor wrapper of the same code)** that staff use for trips |
| Why native | A PWA cannot reliably track GPS in the background. The native app also lets us see exactly when location is switched off. |
| Staff devices | Staff's own phones (BYOD), a mix of iOS and Android |
| Scale | 1–5 cars, 1 office (the office is the return point) |
| Who drives | **One company driver drives every trip** and does not use the app. Staff ride the whole trip, and the staff member who booked (the **trip owner**) runs it on their phone. Only one trip can be out at a time. |
| Car selection | Staff choose a car and see who holds any overlapping time slot. The admin can reassign the car when approving. |
| Joining a trip | The joiner adds a stop to the existing booking. The trip owner is notified and the admin approves or rejects. The original booking stays approved meanwhile. |
| Fuel/cost data | The admin enters fuel manually (per month or per fill-up): **litres + cost** |
| Viewing, property and client cost | **In v1.** Every stop is linked to a property, and every property to its client, from a list kept in the app. Time is reported in hours and in KES, using hourly rates per role. |
| Shared trips | Cost is split across the trip's stops. **The sharing formula is on hold** while the business decides it. |
| Closures | **Imported from the CRM**, matched to properties by CRM reference and to staff by email |
| Login | **Microsoft 365 (Entra ID) single sign-on** |
| Notifications | Push (app, PWA and desktop), email, and WhatsApp/SMS for urgent alerts |
| Region | **Kenya.** Default currency KES. The Kenya Data Protection Act 2019 applies. |
| Approvals | Every admin receives every request, with no auto-approve rules |
| Odometer photo | Required at trip start and end |
| Working hours | Mon–Fri 08:00–18:00, Sat 09:00–13:00 (used for utilisation %) |
| Office return | **20 m** arrival zone around the parking point, with a 150 m wake-up geofence. Overdue grace 15 min, no-show window 30 min. |

---

## 2. Users & Roles

- **Staff (trip owner or passenger):** request trips, see availability, ask to join a trip, start and end trips, see their own history.
- **Admin:** everything staff can do, plus approve, reject or reassign bookings and join requests; see the live map and trip histories; manage cars, the driver, visit reasons, properties and clients, closure imports, hourly rates, office settings and fuel entries; view reports.
- Roles are managed as **Entra ID app roles** (Staff, Admin), so IT controls access from Microsoft 365. When someone leaves the company, their access is removed automatically.
- **Sales staff also use the Dunhill CRM** (the lead-capture app at marketing.erp.dunhill-ticketing.com, repo `diwaliqr`). Every CRM user is a sales user and must also have a Fleet account under the **same Microsoft work email**. That email, entered as their *Work email* in the CRM (Settings → Staff), is what links the two accounts:
  - *Book a car* on a CRM lead opens only that agent's own leads here.
  - Later, viewings and signed deals are credited to the right person.
- **Everyone else, management included, uses Fleet only.** They sign in with Microsoft as usual and have no CRM account or link.
- Fleet signs everyone in with Microsoft. The CRM still keeps its own passwords, so sales staff have one account each but two passwords until the CRM also gets Microsoft sign-in.
- **The company driver is not a user.** He is a record the admin manages (name, phone), used to stop trips overlapping. The **trip owner**, the staff member who booked, starts and ends the trip, enters the odometer readings and carries the tracking phone.

---

## 3. Recommended Architecture

```
 Staff phone (Capacitor app: iOS/Android)        Admin / staff browser (PWA)
   - React SPA (same build as web)                 - React SPA (role-based screens)
   - Background geolocation plugin                 - Live map, approvals, reports
   - Offline queue for GPS + events                - CSV imports (portfolio, CRM closures)
            │  HTTPS (JWT from Entra ID)                     │
            └──────────────────┬─────────────────────────────┘
                               ▼
                 API (Node.js + TypeScript, NestJS or Fastify)
                   - Bookings, trips, tracking ingest, reports
                   - SSE/WebSocket feed for admin live map
                               │
        ┌──────────────┬───────┴────────┬──────────────────┬───────────────────┐
        ▼              ▼                ▼                  ▼                   ▼
  PostgreSQL +    Background       Blob storage      Google Maps        Notifications
  PostGIS         worker (pg-boss) (odometer photos) Platform           FCM/APNs, Web Push,
  (Prisma ORM)    overdue/heartbeat                  (Places, Routes,   Email (MS Graph),
                  monitor, notifications             Maps JS, Geocode)  SMS/WhatsApp
```

### Stack (recommended; the dev team may substitute equivalents)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React + TypeScript + Vite, Tailwind + shadcn/ui | One SPA for staff and admin. PWA via `vite-plugin-pwa`. A plain SPA wraps cleanly in Capacitor (no SSR). |
| Mobile | **Capacitor** (iOS + Android) | Plugins: background geolocation, push, camera (odometer photo), network status |
| Background GPS | **Transistorsoft `capacitor-background-geolocation`** | Proven in production. Includes motion detection, heartbeat, `providerchange` events (location off or permission changed), an offline SQLite buffer and HTTP auto-sync. Android release builds need a paid licence (budget for it). |
| API | Node.js + TypeScript (NestJS or Fastify) | A modular monolith is plenty at this scale |
| Database | PostgreSQL + **PostGIS** | Geofence and distance calculations. `btree_gist` exclusion constraints prevent double booking of a car or the driver. |
| Jobs | **pg-boss** (Postgres-backed queue) | Avoids running Redis. Handles overdue checks, heartbeat monitoring, no-show release and notification dispatch. |
| Auth | Entra ID OIDC (authorization code + PKCE) | Mobile signs in through the system browser. The API validates Entra tokens and app roles. |
| Maps | Google Maps Platform | Maps JavaScript API; **Places API (New)** autocomplete with session tokens; **Routes API** (multi-stop route, distance, ETA); Geocoding (reverse-geocode the last known location) |
| Push | Firebase Cloud Messaging (Android + iOS via APNs), Web Push (VAPID) for PWA/desktop | |
| Email | Microsoft Graph `sendMail` from a shared mailbox | No extra email vendor needed |
| SMS/WhatsApp | Africa's Talking (Kenyan provider, SMS at local rates) or Twilio (WhatsApp + SMS) | Urgent alerts only: overdue trips, tracking lost |
| Hosting | **Azure, South Africa North region** | Nearest Azure region to Kenya. App Service (API and static SPA), Azure Database for PostgreSQL Flexible Server (supports PostGIS), Blob Storage. Fits naturally with M365. |

### Suggested repo layout (monorepo, pnpm workspaces)

```
apps/web       React SPA: staff booking UI + admin dashboard, PWA manifest/service worker
apps/mobile    Capacitor project wrapping apps/web build + native plugin config
apps/api       Node API: auth, bookings, trips, tracking ingest, imports, reports, SSE feed
apps/worker    pg-boss jobs: overdue, heartbeat monitor, no-show release, notifications
packages/db    Prisma schema + migrations (PostGIS)
packages/core  Shared domain logic: availability/conflict check, booking & trip state
               machines, cost and report calculations (unit-tested, used by api + worker)
packages/ui    Shared components: map, bottom sheet, car cards, status badges
```

---

## 4. Core Features & Flows

### 4.1 Booking request (Uber-style UX with our own branding)

One company driver drives every trip, so only one trip can be out at a time. Staff see who holds a taken slot and can ask to add their stop to that trip.

1. Home screen is a full-screen map with a **"Where to?"** bottom sheet. The start point defaults to the office.
2. Add one or more stops by searching the **property list** (address or reference), with Places autocomplete, or by dropping a pin. Stops can be reordered.
3. Pick the **start date/time** and the **estimated return time**.
4. For each stop, pick a **reason for visit** from the admin-managed dropdown, grouped by department (Sales / Lettings / Property Management / Other), with an optional note. Stops whose reason needs a property (viewings, inspections, valuations) must be linked to one. A new property can be added on the spot, with its client.
5. **Check availability.** The app checks the driver first, then the cars, for the chosen window:
   - Driver free → pick any available car. Cars in maintenance are unavailable.
   - Driver out → shows **"Driver is out with Jane M., 10:00–13:00, going to Westlands"**, with **Call / WhatsApp** buttons (staff talk outside the app) and a **"Request to add my stop"** button (§4.2).
6. Route preview shows the estimated distance and duration (Routes API). Submit → **Pending**. Admins are notified.

**Booking states:** `PENDING → APPROVED | REJECTED | CANCELLED`, then `APPROVED → IN_PROGRESS → COMPLETED | AWAITING_ODOMETER`, and `APPROVED → NO_SHOW`. A booking becomes `NO_SHOW` if the trip isn't started within 30 minutes of the start time; the car and driver are released and the admin notified.

**Conflict rules:**
- Only `APPROVED`/`IN_PROGRESS` bookings block. Each one blocks its car **and the driver**, so with one driver only one trip can be out at a time.
- `PENDING` overlaps show as "tentative" to staff and are highlighted to the admin.
- The database rejects overlapping approved bookings with two Postgres exclusion constraints, one on `car_id` and one on `driver_id` (each `WITH =` plus `tstzrange(start, return) WITH &&`). This holds even if two admins approve at the same moment.
- The driver is a record the admin manages, not a login. Adding a second driver later lets two trips run at once with no code change.

### 4.2 Joining someone else's trip (add a stop)
1. The joiner taps "Request to add my stop" on a taken slot, then adds stop(s) with their property and reason and, if needed, a later return time.
2. The **trip owner is notified** for information. The **admin approves or rejects** the change, and the original booking stays approved throughout.
3. On approval, the stop is inserted into the route, the joiner is listed as a **passenger**, and the route and ETA are recalculated. If the later return time clashes with the next booking, the admin sees the clash before approving.
4. If the original booking is cancelled or rejected, pending join requests are cancelled automatically and the joiner is notified.

### 4.3 Admin approval
- An approval queue lists bookings and join requests with a map preview, reason, requester and any conflicts.
- Actions: **Approve**, **Reject** (a reason is required), or **Reassign car** then approve.
- Every decision is written to an audit log, and the requester is notified (push + email).

### 4.4 Trip lifecycle (native app only, on the trip owner's phone)

The company driver does not use the app. The trip owner rides the whole trip and runs it on their phone.

**Start**
- Available from 30 minutes before the booked start (configurable), only to the trip owner.
- The trip owner enters the **start odometer reading** and takes a **dashboard photo** (required). The reading must be ≥ the car's last recorded end reading. If it is higher, the gap is saved as **unlogged km** (§4.7).
- The app checks for location permission set to **"Always"** and walks them through enabling it, including the Android battery-optimisation exemption. Tracking then starts.

**During**
- The staff screen shows the map, route, stops checklist, ETA and a large **End trip** button. A persistent notification says "Trip tracking active" (Android requires this anyway).
- **GPS capture:** a point every ~50 m or ~30 s while moving, and a **heartbeat every 5 minutes** while stationary. Each point carries accuracy, speed and **battery level**.
- **Offline buffering:** GPS keeps working without mobile data. Points are stored on the device and uploaded when the connection returns, so the route is backfilled.
- **Time at each stop:** the app records arrival and departure at each stop automatically, when the phone is within 50 m of the stop and still for 2+ minutes. Staff can also tap **Arrived** and **Leaving** on the stops checklist. These times feed the time-cost reports.
- **Tracking runs only between trip start and trip end.** This matters for privacy on personal phones.

**What the admin sees when tracking is interrupted**

| Situation | How it's detected | Admin sees |
|---|---|---|
| Location services turned off, or permission downgraded | Device `providerchange` event. Sent immediately if online, otherwise queued. | 🔴 "Location turned OFF at 14:02" plus the last location. Later: "Back ON at 14:20". |
| Mobile data off / no signal | Server sees no contact for more than 5 minutes. On reconnect, the device uploads its buffered points and its network on/off log. | 🟠 "Offline since 14:02 (last seen near X)". After reconnect, the timeline shows the device-reported offline window and the backfilled route. |
| App force-closed / phone switched off / battery dead | No contact and no reconnect. Last battery % is known. | ⚫ "Tracking lost, last seen 14:02 at X, battery 3%" |
| Overdue | Worker job: ETA + grace period (15 min) has passed | Push to the trip owner, then push + SMS/WhatsApp to the admin |

*Limitation to note:* iOS does not expose "user switched off mobile data" as distinct from "no coverage". The timeline therefore shows "device offline". Android can additionally flag **airplane mode**.

**End**
- **Manual:** the trip owner taps End trip, then enters the **end odometer reading** (must be ≥ the start reading) and takes a photo (required).
- **Back at office:** a 150 m geofence wakes the app as the car approaches. The car counts as back when a GPS fix puts the phone within **20 m of the office parking point** (allowing for the fix's reported accuracy) and it stays still for about 2 minutes. The app then prompts "Back at the office? End trip". If the trip isn't ended within N minutes, tracking stops, the trip moves to `AWAITING_ODOMETER`, and the trip owner and admin are reminded. The admin can close it by entering the reading.
- **Why two zones:** phone GPS is usually accurate to 5–20 m, and iOS/Android geofences are unreliable below about 100 m. A 20 m geofence on its own would often never fire.
- The trip owner can **extend the ETA** mid-trip. If that clashes with the next booking, the next booker and the admin are notified.

### 4.5 Admin dashboard
- **Live map:** cars at the office and active trips, each with a status badge (Live / Offline since / Location off / Tracking lost) and last-seen time and address.
- **Calendar/timeline:** one row per car (Gantt-style) showing approved, pending and in-progress bookings.
- **Trip detail:** planned vs actual route replay, stops with arrival and departure times, an event timeline (start, location off/on, offline, overdue, geofence, end), the **final known location and status**, odometer photos, and odometer km vs GPS km with a variance flag.
- **Management screens:**
  - Cars: registration, make/model, fuel type, status (available or maintenance), current odometer
  - Driver: name and phone (a record, not a login)
  - **Visit reasons:** add, edit, reorder and archive. Archived reasons stay in history and reports. Each reason is flagged if it counts as a viewing and if it needs a property.
  - Users: synced from Entra, with role and phone number
  - Properties and clients, closure imports, hourly rates (§4.6)
  - Office: address, parking point, 20 m arrival zone, 150 m wake-up geofence
  - Settings: currency (default KES), working hours, grace periods, heartbeat and offline thresholds, start window
  - Fuel entries

### 4.6 Properties, clients and closures

Every stop is linked to a property and every property to its client, so the app can total what each one costs. Closures come from the CRM, so the app can set that cost against results.

- **Portfolio list (kept in the app):** the admin imports current properties and clients once from a CSV: reference, CRM reference, address, service (sales, lettings, management) and client. Staff can add a property while booking, and the admin reviews new ones.
- **Property status:** active, sold, let or withdrawn. Closures update it.
- **Closures (from the CRM):** the admin uploads the CRM's closures export (CSV) on a schedule, for example monthly. Each row is matched to a property by CRM reference and to a staff member by email. Unmatched rows go to a review queue. A direct CRM sync can replace the upload once the CRM is confirmed.
- **Hourly rates:** the admin sets an hourly cost rate in KES for each staff role and for the driver. Rates are dated, so changing a rate doesn't rewrite past reports.

### 4.7 Fuel entry, costs & reports (v1)
**Fuel entry (admin):** car, date (or month), **litres**, **amount** (KES), optional odometer reading and receipt photo. Litres are mandatory; without them km/L can't be calculated.

**Calculations** (live in `packages/core`, unit-tested):
- **Trip km** = end odometer − start odometer. GPS km is stored alongside for comparison.
- **Car km per period** = total trip km in the period, plus **unlogged km** (the gap between one trip's end reading and the next trip's start reading).
- **Fuel efficiency** = km ÷ litres (km/L), also shown as L/100 km. Shown monthly and as a **rolling 3-month average**, because a monthly fill-up doesn't match that month's actual consumption.
- **Cost per km** = fuel cost ÷ km, per car and per period.
- **Trip cost** = fuel cost (trip km × the car's cost per km) + **time cost** (trip hours × the hourly rate of each staff member on board and of the driver).
- **Stop cost** = the stop's share of the trip's fuel and travel time, plus the time spent at the stop (arrival to departure). **The formula for sharing a trip across its stops is on hold** while the business decides it; the reports are built so it can be plugged in.
- **Viewing, property and client cost** = the total of the stop costs linked to them. Each stop is credited to the staff member who added it.

**Reports** (filters: date range, car, staff, department, reason, property, client; CSV/Excel export):
1. Fuel efficiency by car (trend over time)
2. Cost per km and total fuel cost by car and month
3. Usage: trips, km, hours out, and **utilisation %** (booked hours ÷ working hours, Mon–Fri 08:00–18:00 and Sat 09:00–13:00) by car, driver, staff, department and reason
4. Cost allocation by department, reason and staff
5. **Compliance:** unlogged km, odometer vs GPS variance, location-off and tracking-lost events per staff member, overdue returns, no-shows, rejected and cancelled bookings
6. **Cost per viewing:** fuel and time (hours and KES) for each viewing, averaged by property, service (sales or lettings) and staff member
7. **Property and client cost:** visits by reason, hours, km and KES per property and per client, set against closures and fees. Flags properties with many viewings and no closure, answering "is this property worth the viewings?"
8. **Staff effectiveness:** for each staff member, viewings, closures (from the CRM), viewings per closure, cost per closure and average days from first viewing to closure, ranked

---

## 5. Data Model (core entities)

| Entity | Key fields |
|---|---|
| `User` | entra_oid, name, email, phone, role, department, active |
| `Driver` | name, phone, active. A resource the admin manages, not a login. |
| `Office` | name, address, parking_point (geography point), arrival_radius_m (20), wakeup_radius_m (150) |
| `Car` | registration, make, model, fuel_type, status, home_office_id, current_odometer |
| `VisitReason` | label, department, counts_as_viewing, needs_property, sort_order, active |
| `Client` | name, type (vendor, landlord, other), phone, email, crm_ref |
| `Property` | ref, crm_ref, address, location, client_id, service (sales, lettings, management), status (active, sold, let, withdrawn), created_by |
| `Closure` | property_id, staff_id, closed_at, deal_type (sale, letting), fee (optional), crm_ref, import_batch |
| `HourlyRate` | applies_to (staff role or driver), rate_kes, effective_from |
| `Booking` | owner_id (staff who booked), driver_id, car_id, status, start_at, expected_return_at, reason_id, notes, planned_distance_km, planned_polyline, decided_by, decided_at, rejection_reason |
| `BookingStop` | booking_id, seq, property_id (when the reason needs one), place_id, address, location, added_by, reason_id, status, arrived_at, departed_at |
| `BookingPassenger` | booking_id, user_id |
| `JoinRequest` | booking_id, requester_id, proposed stops, reason_id, proposed_return_at, status, decided_by |
| `Trip` | booking_id, started_at, ended_at, odometer_start/end, photo_start/end, end_method (manual/geofence/admin), gps_distance_km, last_location, last_seen_at, tracking_status |
| `LocationPoint` | trip_id, recorded_at, location, accuracy, speed, heading, battery, is_moving |
| `TrackingEvent` | trip_id, type (location_off/on, permission_changed, offline/online, airplane_mode, heartbeat_missed, geofence_enter/exit, overdue, low_battery), occurred_at, source (device/server), details |
| `FuelEntry` | car_id, date, litres, amount, currency, odometer (opt), receipt_url (opt), entered_by |
| `Notification` | user_id, channel, type, payload, status, sent_at |
| `AuditLog` | actor_id, action, entity, entity_id, before, after, at |
| `Setting` | key/value: currency, thresholds, grace periods, working hours |

Store all timestamps in UTC and display them in East Africa Time. Location data volume is small at this scale (5 cars), so no partitioning is needed.

---

## 6. Non-Functional Requirements

- **Privacy & legal (Kenya Data Protection Act 2019):**
  - Track only during trips.
  - Show a clear privacy notice and get acknowledgement at first login.
  - Retention policy: for example, keep raw GPS points for 12 months, then keep only trip summaries.
  - Location data is visible to admins only, and views are audit-logged.
  - **Have legal/HR review the policy before rollout**, including registration with the Office of the Data Protection Commissioner (ODPC) and the legal basis for hosting data in South Africa, since staff use personal phones.
- **Security:**
  - Entra SSO with role checks enforced **in the API**, not just the UI.
  - Signed upload URLs for photos.
  - Restrict Maps API keys by HTTP referrer, iOS bundle ID and Android package name/SHA.
  - Set Google Cloud budget alerts.
- **Connectivity:** the app must cope with patchy coverage. Starting and ending a trip work offline (timestamped on the device, synced later), and GPS is buffered on the device.
- **Android device quirks:** Tecno, Infinix, Xiaomi, Samsung and similar brands aggressively kill background apps. Build an in-app setup guide for battery-optimisation and autostart settings (see dontkillmyapp.com), and test on these brands.
- **App store distribution (BYOD):**
  - Register **Organisation** developer accounts with Apple and Google (needs a D-U-N-S number), so the Play Store's 12-tester requirement for personal accounts doesn't apply.
  - On iOS, use **Unlisted App Distribution**. On Google Play, use a normal listing gated by SSO.
  - Both stores require a written justification and demo video for **background location**. Prepare these early.
- **Google Maps cost:** use autocomplete session tokens and cache routes. At 1–5 cars, usage should stay low, but monitor it.

---

## 7. Delivery Phases (indicative, for 2 full-stack devs + part-time designer/QA)

Total: **14–20 weeks** from kickoff to launch.

| Phase | Scope | Indicative effort |
|---|---|---|
| **0. Setup & design** | Uber-style wireframes and clickable prototype; Azure, Entra app registration (roles), Google Cloud (Maps keys), Apple/Google org developer accounts, FCM; geolocation plugin licence; draft privacy notice/DPIA | 1–2 weeks |
| **1. Booking core** | SSO and roles; cars, driver, reasons, office and settings admin; property and client list with CSV import; map booking flow with multiple stops, each linked to a property; driver and car availability with "booked by" and call/WhatsApp; admin approve/reject/reassign; join-a-trip flow; push + email notifications; calendar view | 4–5 weeks |
| **2. Trips & tracking** | Capacitor app; start/end with odometer and photo; background tracking with offline buffer; arrival and departure at each stop; tracking events and status logic; worker jobs (heartbeat monitor, overdue, no-show); office arrival zone and end-trip prompt; admin live map and trip replay/timeline; SMS/WhatsApp urgent alerts | 4–5 weeks |
| **3. Fuel, costs & reports** | Fuel entry; hourly rates; CRM closures import with review queue; calculation engine in `packages/core`; the 8 reports; CSV/Excel export | 3–5 weeks |
| **4. Pilot & launch** | Pilot with 1–2 cars and 3–5 staff for 2 weeks; field-test on iPhone and several Android brands; fix issues; store submission; staff onboarding guide | 2–3 weeks |
| **Later** | Direct CRM sync for closures; fixed costs (lease, insurance, service) for full cost of ownership; fuel card CSV import; Teams notifications; vehicle checks and damage photos; service reminders | — |

---

## 8. Acceptance Tests / Verification

Unit tests in `packages/core` for availability and conflicts, the state machines, and the cost and report maths. End-to-end tests (Playwright) for web flows. **Real-device field tests** for tracking. Key scenarios:

1. Two staff request overlapping times, on the same car or different cars. The second sees "Driver is out with…" with call/WhatsApp. If two admins approve both at once, only one approval succeeds (database constraint).
2. Full join flow: the joiner requests a stop, the trip owner is notified, the admin approves, the stop and passenger appear on the trip, and the route and ETA update.
3. Start trip with an odometer reading lower than the last end reading → blocked. Higher → unlogged km recorded.
4. Mid-trip, the trip owner turns off location → the admin sees "Location OFF at hh:mm" plus the last location within about 1 minute (while online).
5. The trip owner turns off mobile data for 20 minutes during a trip → the admin sees "Offline since…". On reconnect, the route gap is backfilled and the timeline shows the offline window.
6. Force-quit the app or power off the phone → "Tracking lost, last seen…, battery %".
7. Stopping within 20 m of the office parking point → end-trip prompt appears. Driving past the office without stopping → no prompt. Ignoring the prompt → `AWAITING_ODOMETER` and reminders.
8. Pass the ETA plus the grace period → the trip owner gets a push, then the admin gets a push and SMS/WhatsApp.
9. A booking not started within the no-show window → auto-released and the admin notified.
10. Reports: for a seeded test month, the km/L, cost per km, cost per viewing, property and client cost, and staff ranking figures match a hand-calculated spreadsheet.
11. Battery: a 4-hour trip on a mid-range Android phone and an iPhone uses an acceptable amount of battery (target under 10–15%).
12. Arrival and departure times at a viewing are recorded from GPS within about 2 minutes of the real times.
13. A CRM closures CSV with one unknown property reference imports the other rows and puts that one in the review queue.

---

## 9. Open Questions

- The formula for sharing a trip's fuel and travel time across its stops (on hold).
- ~~Which CRM is used?~~ **Decided:** the Dunhill CRM (`diwaliqr`). Fleet pulls its listings nightly and opens its leads from *Book a car*. Closures will come from its *Signed* outcome over the same link; the CSV import stays as a fallback.
- Hourly cost rates in KES for each staff role and for the driver.
