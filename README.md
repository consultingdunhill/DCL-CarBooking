# Fleet: company car booking & trip tracking

Staff book a company car on an Uber-style map, admins approve, the trip owner runs the trip from the phone app (odometer + photo at start and end, background GPS), and admins get a live map, alerts when tracking is interrupted, and cost reports down to each viewing, property and client. See [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) for the product spec.

## Repo layout

| Path | What |
|---|---|
| `apps/web` | React SPA (Vite, Tailwind, React Router, TanStack Query): staff booking + admin dashboard, PWA |
| `apps/mobile` | Capacitor wrapper of `apps/web` for iOS/Android (background tracking). See [apps/mobile/README.md](apps/mobile/README.md) |
| `apps/api` | Fastify API: auth, bookings, trips, tracking ingest, imports, reports, SSE live feed |
| `apps/worker` | pg-boss jobs: heartbeat monitor, overdue, no-show, odometer reminders, GPS retention, notification delivery |
| `packages/core` | Pure domain logic shared by everything: availability/conflicts, state machines, zones, cost and report maths, request schemas |
| `packages/db` | Prisma schema, migrations (PostGIS, exclusion constraints), dev seed |
| `packages/server` | Server-side services shared by api and worker: settings, notifications, live events, tracking status, monitors |

## Run it locally

Needs Node 22+ and Docker.

```bash
corepack enable                   # once per machine: puts the repo's pnpm version on your PATH
cp .env.example .env              # works as-is for local development
pnpm install
pnpm db:up                        # PostGIS on localhost:5433
pnpm db:migrate
pnpm db:seed                      # office, 3 cars, driver, 5 users, 10 properties, ~2 months of trips
pnpm dev                          # api :4000, worker, web :5173
```

Open http://localhost:5173 and pick a user (dev sign-in). Grace Wanjiru is an admin; the others are staff. `pnpm db:seed --reset` wipes and re-seeds.

With no external accounts configured, everything still runs locally:

| Service | Configured (production) | Fallback (development) |
|---|---|---|
| Sign-in | Microsoft Entra ID (`AUTH_MODE=entra`) | User picker (`AUTH_MODE=dev`; refused in production) |
| Maps | Google Maps JS + Places (`VITE_GOOGLE_MAPS_API_KEY`), Routes + Geocoding (`GOOGLE_MAPS_SERVER_KEY`) | OpenStreetMap tiles, straight-line route estimates, nearest-property "last seen near" |
| Photos | Azure Blob with SAS URLs (`STORAGE_DRIVER=azure`) | `apps/api/storage` with signed URLs |
| Push | Web Push (VAPID) + FCM | In-app notifications only |
| Email | Microsoft Graph `sendMail` | Logged by the worker |
| SMS | Africa's Talking or Twilio | Logged by the worker |
| WhatsApp | A linked company WhatsApp number via Baileys (`WHATSAPP_PROVIDER=baileys`, scan the QR in Admin → Office & settings), or Twilio | Logged by the worker |

Trips run in the native app. To try one in a desktop browser, `VITE_ALLOW_WEB_TRIPS=true` (default in `.env.example`) enables foreground-only GPS.

### Try it on a phone (testing only)

Installing the app on a phone needs HTTPS, so `pnpm share` serves the production build from this machine through a free Cloudflare quick tunnel:

```bash
# once: install cloudflared (Debian/Ubuntu; other systems: Cloudflare's "Downloads" page for cloudflared)
curl -fsSLo /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo apt install /tmp/cloudflared.deb

pnpm db:up                        # stop `pnpm dev` first: share uses ports 4000 and 4173
pnpm share                        # prints https://<random>.trycloudflare.com
```

Open the printed address on the phone, pick a user, then add Fleet to the home screen. Keep in mind:

- The address changes every time `pnpm share` starts, and an installed app is tied to its address: remove the old icon and add it again.
- It only works while this machine is on, awake and online.
- Anyone with the address can use dev sign-in, so share it only with testers and stop it (Ctrl+C) when you're done.

## Tests

```bash
pnpm --filter @carbooking/core test   # 57 unit tests: availability, state machines, zones, costs, reports
pnpm --filter @carbooking/api test    # 18 API flows against Postgres (creates carbooking_test)
pnpm typecheck
```

The API tests cover the acceptance scenarios in DEVELOPMENT_PLAN §8 that don't need a phone: concurrent approvals (only one succeeds, enforced by the database), the join flow, odometer rules, location off / offline with backfill / tracking lost, office arrival → `AWAITING_ODOMETER`, overdue escalation, no-show release, and the closures import review queue. Scenarios 4–8, 11 and 12 still need real-device field tests.

## Key design points

- **No double booking**: two Postgres exclusion constraints (`booking_car_no_overlap`, `booking_driver_no_overlap`) reject overlapping APPROVED/IN_PROGRESS bookings. One driver means one trip out at a time; adding a second driver record lets two run with no code change.
- **Tracking**: the phone posts GPS in batches (Transistorsoft HTTP sync format) with a trip-scoped token that can do nothing else. The server derives Live / Offline / Location off / Tracking lost from last contact, device events and battery; the worker re-checks every minute. Stop arrival/departure and office arrival (20 m zone, 2-minute dwell, after leaving the 150 m geofence) are detected server-side from the track, so backfilled data counts too.
- **Offline**: trip start/end and stop actions (with photos) queue in IndexedDB with idempotency keys; GPS buffers in the plugin's SQLite store.
- **Privacy (Kenya DPA 2019)**: tracking only between trip start and end; privacy notice acknowledged at first sign-in; location visible to admins only and every view audit-logged; raw GPS deleted after the retention period (default 12 months). **Legal/HR must review the notice text** (`apps/web/src/components/PrivacyNotice.tsx`) before rollout.
- **Costs**: trip cost = km × the car's cost per km (rolling 3-month fuel figures) + hours × the hourly rates of everyone on board. **The formula for sharing a trip across its stops is on hold**; it is a setting (`stopCostSplit`, default `EQUAL`) and reports label it provisional.
- **Emergencies and changing plans**: a request can be flagged *Urgent* (every admin gets push + SMS/WhatsApp; it still needs approval and goes to the top of the queue). An admin can book on a staff member's behalf after a phone call; that booking is the admin's decision, so it is approved straight away (audit-logged as `BOOKING_CREATED_BY_ADMIN`, still subject to the no-double-booking constraints). During a trip the trip owner can add a stop (search, current location or map pin) or change an upcoming one; the route is recalculated, the timeline records it and admins are told.
- **Times** are stored in UTC and shown in East Africa Time; currency defaults to KES (both are settings).

## Production checklist

1. Azure (South Africa North): App Service for API + worker + static web, PostgreSQL Flexible Server with `postgis` and `btree_gist` allow-listed, Blob Storage container.
2. Entra app registrations: API (expose a scope, app roles **Staff** and **Admin**) and SPA/mobile client (redirects: web origin, `ke.co.fleet.app://auth`). Set `AUTH_MODE=entra` and the `ENTRA_*` / `VITE_ENTRA_*` variables.
3. Google Cloud: browser key restricted by referrer and app IDs; server key for Routes/Geocoding; budget alerts.
4. Generate `APP_SECRET` (32+ random bytes) and VAPID keys; add FCM service account, Graph mail credentials, SMS provider. For WhatsApp via Baileys, give the worker a persistent `WHATSAPP_AUTH_DIR` (e.g. `/home/whatsapp` on App Service), run **one** worker instance, and link a dedicated company number. It is an unofficial client: WhatsApp can block numbers it considers automated.
5. `pnpm db:migrate` (deploys migrations), then `pnpm build`; run `apps/api/dist/index.js` and `apps/worker/dist/index.js`.
6. Mobile: see [apps/mobile/README.md](apps/mobile/README.md) (Transistorsoft licence, store accounts, background-location justification).

## Open questions (from the plan)

- How a trip's fuel and travel time are shared across its stops (currently equal split, configurable).
- ~~Which CRM~~ Decided: the Dunhill CRM (`diwaliqr`), linked by `CRM_API_URL` / `CRM_API_TOKEN`. Its users are the sales staff and need a Fleet account under the same Microsoft work email; management and other staff use Fleet only. Closures still come in by CSV (template at Admin → CRM closures) until the deals link is built.
- Hourly cost rates per job role and for the driver (seeded with placeholders; set them in Admin → Hourly rates).
