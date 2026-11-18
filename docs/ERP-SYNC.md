# ERPNext copy of Fleet

Fleet Managers can see Fleet in ERPNext, the company ERP, under **Dunhill Fleet**. The copy is read-only, and Fleet stays the system of record: staff still book and run trips here, and ERPNext follows within a couple of minutes. The CRM keeps a copy the same way (its `docs/ERP-SYNC.md`).

## What goes across

| Fleet | ERPNext doctype | Name | Who can see it |
|---|---|---|---|
| Car | Fleet Car ("Cars") | `CAR-1a2b3c4d` | Fleet User, Fleet Manager |
| Booking: stops, trip, costs | Fleet Booking ("Bookings") | `BK-1a2b3c4d` | Fleet User, Fleet Manager. **Costs: Fleet Manager only** |
| Fuel entry | Fleet Fuel Entry ("Fuel") | `FUEL-1a2b3c4d` | Fleet Manager |
| A car's month (km, litres, km/L, cost per km) | Fleet Car Month ("Monthly car figures") | `CM-1a2b3c4d-2026-11` | Fleet Manager |

- **Costs come from Fleet's own report code** (`costedTripsAndCarMonths` in `packages/core/src/reports.ts`), so ERPNext and Fleet's reports always agree.
- **The costs are on a second permission level,** which only Fleet Managers can read, as in Fleet, where costs are admin-only.
- **A stop links to the CRM's listing (`PROP-0042`) and lead (`LEAD-0042`) in ERPNext** when those are there.
- **ERPNext's cost reports are for Fleet Managers:** "Cost per viewing", "Cost by property" and "Cost by agent".

## How it works

`packages/server/src/erp/` runs in the worker every 2 minutes:
- It builds each record as ERPNext should hold it.
- It compares a hash with `ErpSyncState` and sends only what changed.
- Records gone from Fleet are deleted from ERPNext.
- One record that ERPNext refuses doesn't stop the others. It's retried every 30 minutes while unchanged, and its error is kept in `ErpSyncState.lastError`.

At 02:15 Nairobi time a reconcile repairs drift: anything deleted in ERPNext by hand is sent again, and anything named like ours that Fleet doesn't have is removed.

## Knowing it's working

Every run, even one with nothing to send, does two things:
- It rewrites one ERPNext record, **Fleet Sync Status** ("Sync status").
- It saves `erp_sync_health` in the `Setting` table.

What you see:
- **In ERPNext:** the card at the top of the Dunhill Fleet page.

  | Card | Meaning |
  |---|---|
  | Green | Synced recently |
  | Amber | Records stuck |
  | Red | No run for 15 minutes or more |
- **In Fleet:** admins see a red bar above every page (`GET /admin/erp-sync`) when the sync:
  - is switched on but hasn't run
  - has stopped
  - can't reach ERPNext
  - has stuck records

## Changing what goes across

The ERPNext doctypes are defined in `packages/server/src/erp/schema.ts`, from Fleet's own enums. ERPNext rejects a Select value outside its options, so the two must not drift. After a change:

```bash
pnpm erp:schema --out ../dunhill-erp/objects/fleet/doctypes
cd ../dunhill-erp && python3 scripts/provision.py --site staging            # dry run
python3 scripts/provision.py --site staging --apply
```

## Switching it on

In `.env`:

```
ERP_SYNC_ENABLED=true
ERP_URL=https://erp.example.com
ERP_API_KEY=...          # the ERP sync user (role "Dunhill Integration" only)
ERP_API_SECRET=...
```

`ERP_USER`/`ERP_PASSWORD` sign in with a password instead, for a site that can't take an API key yet. Deploy as usual: the migration creates `ErpSyncState`, and the worker picks the jobs up.

## Commands

```bash
pnpm erp:sync --dry-run          # what would be sent (locally)
pnpm erp:sync                    # send what changed now
pnpm erp:sync --reconcile        # repair drift, then a normal pass
pnpm erp:sync --force --only bookings
# on the server:
docker compose -f docker-compose.prod.yml exec worker node dist/erp-cli.js sync --dry-run
```
