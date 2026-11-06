# Deploying Fleet onto the ERP server

Fleet goes on the same box as the CRM, **`deploy@217.216.77.107`** (SSH on port 22). `deploy`
is in the `docker` group, so compose needs no sudo; nginx and certbot changes do.

It runs as its own compose project in `/opt/clients/fleet`, from
[docker-compose.prod.yml](../docker-compose.prod.yml):

| Container | What it is | Reachable at |
|---|---|---|
| `db` | Fleet's own PostGIS database, apart from the CRM's | inside the project only |
| `api` | The API. Applies any pending migrations each time it starts | `web`, and the `dunhill-internal` network |
| `worker` | Background jobs, including the CRM sync and the viewings push | `dunhill-internal` network |
| `web` | The built app behind nginx, which passes `/api` on to `api` | `127.0.0.1:8090` only |

The server's nginx publishes `web` as **https://fleet.erp.dunhill-ticketing.com**. Fleet
reaches the CRM over the `dunhill-internal` Docker network as `http://crm:8000`, so those
calls never leave the server.

Fill these in and keep them beside you:

| | Value |
|---|---|
| `SERVER` | `deploy@217.216.77.107` |
| `DOMAIN` | `fleet.erp.dunhill-ticketing.com` |
| already on the box | the CRM (`127.0.0.1:8088`), its WhatsApp gateway (`127.0.0.1:3100`), the ERP |

---

## Before you start

- **Microsoft sign-in must be set up.** In production the API refuses the dev user picker
  (`AUTH_MODE=dev is not allowed in production`). You need the two Entra app registrations from
  the [README's production checklist](../README.md#production-checklist), item 2: the API (app
  roles **Staff** and **Admin**, and an exposed scope) and the web/mobile client. Have these
  values to hand: the tenant ID, the API's application ID URI and its scope, and the client's
  application ID. Add `https://fleet.erp.dunhill-ticketing.com` as a redirect URI on the client.
- **The CRM must be on a version with the Fleet link**, with `alembic upgrade head` applied
  (migrations `b8d2e6f1a3c7`, `c3e9a7b5d214` and `e7b3c5a9d146`). See the CRM's own
  `docs/DEPLOY.md` → *Updating later*.
- **Deploy from `main`** once the Fleet PRs are merged: `git checkout main && git pull`.

---

## 1. Create the subdomain

> Cloudflare → `dunhill-ticketing.com` → **DNS** → **Add record**
>
> | Type | Name | IPv4 address | Proxy status | TTL |
> |---|---|---|---|---|
> | A | `fleet.erp` | `217.216.77.107` | **DNS only** (grey cloud) | Auto |

DNS only, for the same reason as the CRM's `marketing.erp`. Cloudflare's free certificate
covers one level of subdomain, and this name has two. Proxied (orange cloud), visitors would get
a certificate warning and certbot's challenge would never reach the server.

```bash
dig +short fleet.erp.dunhill-ticketing.com      # want: 217.216.77.107, and nothing else
```

## 2. Confirm the ground

```bash
ssh SERVER
ss -lntp | grep -E ':8090\s'        # must print nothing; else set FLEET_BIND_PORT in .env
docker --version && docker compose version
free -h; df -h /                     # the first build wants ~2 GB of RAM and ~5 GB of disk
ls /etc/nginx/conf.d/                # fleet.conf must not exist yet
```

If the box is short of memory, build on the laptop instead and ship the images:
`docker compose -f docker-compose.prod.yml build`, then
`docker save fleet-server fleet-web | ssh SERVER docker load`. Then use `up -d` without `--build`
in step 6.

## 3. The shared network: once

```bash
docker network create dunhill-internal
```

Then redeploy the CRM, whose `docker-compose.yml` now puts its `app` container on this network
as `crm`. Use the CRM's *Updating later* steps. Its `.env` also gains two lines:

```bash
FLEET_INTEGRATION_TOKEN=<openssl rand -hex 32; the same value goes into Fleet's CRM_API_TOKEN>
FLEET_APP_URL=https://fleet.erp.dunhill-ticketing.com
```

Check:

```bash
docker network inspect dunhill-internal --format '{{range .Containers}}{{.Name}} {{end}}'
# want: diwaliqr-app-1
```

## 4. Copy the code up

```bash
ssh SERVER 'sudo mkdir -p /opt/clients/fleet && sudo chown deploy:deploy /opt/clients/fleet'

# laptop: preview first. -n changes nothing; read the list before going on
rsync -avzn --delete --exclude='node_modules/' --exclude='dist/' --exclude='.git/' \
  --exclude='.env*' --exclude='apps/api/storage/' --exclude='.whatsapp-auth/' \
  --exclude='apps/mobile/android/' --exclude='apps/mobile/ios/' \
  ~/projects/carbooking/ SERVER:/opt/clients/fleet/

# then the same without -n
```

`--exclude='.env*'` keeps the laptop's development `.env` off the server, and the server's
own `.env` safe from `--delete`.

## 5. The production .env

On the server, create `/opt/clients/fleet/.env` and run `chmod 600 .env`. [.env.example](../.env.example) explains
every variable; these are the production values:

```bash
# ── Core ──
POSTGRES_PASSWORD=<openssl rand -hex 24>
APP_URL=https://fleet.erp.dunhill-ticketing.com
API_PUBLIC_URL=https://fleet.erp.dunhill-ticketing.com/api
CORS_ORIGINS=https://fleet.erp.dunhill-ticketing.com,capacitor://localhost,https://localhost
APP_SECRET=<openssl rand -hex 32>

# ── Microsoft sign-in (both halves: the API checks tokens, the web build signs in) ──
AUTH_MODE=entra
ENTRA_TENANT_ID=<tenant id>
ENTRA_API_AUDIENCE=api://<api client id>
VITE_AUTH_MODE=entra
VITE_ENTRA_TENANT_ID=<tenant id>
VITE_ENTRA_CLIENT_ID=<web/mobile client id>
VITE_ENTRA_API_SCOPE=api://<api client id>/access_as_user

# ── The CRM, over the shared network ──
CRM_API_URL=http://crm:8000
CRM_API_TOKEN=<the CRM's FLEET_INTEGRATION_TOKEN>

# ── Trips from the phone's browser, until the Fleet app is distributed ──
# Foreground GPS only: it records while the screen is on and Fleet is open.
VITE_ALLOW_WEB_TRIPS=true

# ── Off until each is ready ──
STORAGE_DRIVER=local
TRACKER_PROVIDER=none
SMS_PROVIDER=none
WHATSAPP_PROVIDER=none
```

Add these when they exist: `GOOGLE_MAPS_SERVER_KEY` and `VITE_GOOGLE_MAPS_API_KEY` (real road
routes and maps); `VAPID_*` and `VITE_VAPID_PUBLIC_KEY` (web push); `FCM_SERVICE_ACCOUNT_BASE64`
(phone push); `GRAPH_*` (email); and an SMS provider. Until then the app uses free maps,
straight-line distances and logged notifications. Leave `TRACKER_PROVIDER=none`: Oversee's API
only answers its own website, so the car trackers' paths come from Oversee's history export,
uploaded per car under **Cars & driver → Tracker history**. Leave `DATABASE_URL`, `NODE_ENV`, `STORAGE_LOCAL_DIR` and `WHATSAPP_AUTH_DIR` out:
the compose file sets them.

## 6. Build and start

```bash
cd /opt/clients/fleet
docker compose -f docker-compose.prod.yml up -d --build      # the first build takes a while
docker compose -f docker-compose.prod.yml ps                  # db, api healthy; worker, web up
docker compose -f docker-compose.prod.yml logs api | tail -5  # "API listening on :4000 (auth: entra, ...)"
curl -fsS http://127.0.0.1:8090/api/health && echo
```

The CRM link, from inside Fleet. Both should print 200:

```bash
docker compose -f docker-compose.prod.yml exec api node -e "fetch('http://crm:8000/health').then(r => console.log(r.status))"
docker compose -f docker-compose.prod.yml exec api node -e "fetch(process.env.CRM_API_URL + '/api/integrations/fleet/users', { headers: { authorization: 'Bearer ' + process.env.CRM_API_TOKEN } }).then(r => console.log(r.status))"
```

A 404 on the second means the CRM's `FLEET_INTEGRATION_TOKEN` is blank. A 401 means the two
tokens differ.

## 7. Publish it through the server's nginx

```bash
sudo cp /opt/clients/fleet/deploy/nginx/fleet.conf /etc/nginx/conf.d/fleet.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d fleet.erp.dunhill-ticketing.com      # choose redirect
```

`nginx -t` must pass before the reload. Afterwards `ls /etc/nginx/conf.d/` should show only
`fleet.conf` as new, and the CRM and the ERP must still load.

### Verify from outside

```bash
curl -sI https://fleet.erp.dunhill-ticketing.com/ | head -1          # HTTP/2 200
curl -s  https://fleet.erp.dunhill-ticketing.com/api/health && echo
```

## 8. First sign-in and setup

1. In Entra → Enterprise applications → the Fleet API → **Users and groups**, give yourself
   **Admin**, and every other user **Staff**. Sales staff must sign in with the same Microsoft
   address that is entered as their *Work email* in the CRM's Settings → Staff. That is how
   the CRM's leads are matched to them.
2. Sign in at https://fleet.erp.dunhill-ticketing.com and accept the privacy notice.
3. The database starts empty. In Admin, set up the **office** (address, pin and arrival radius),
   then the **cars**, **drivers**, **job roles and hourly rates**, and **visit reasons**. Mark the
   viewing reasons *counts as viewing*, or the CRM's follow-up won't move when one is booked.
4. Admin → Properties → **Sync from CRM** pulls in the CRM's portfolio now. After that it runs
   nightly.

## 9. Check the whole loop once

In the CRM, open a lead assigned to a sales agent, tick a matched listing and press **Book a
car**. Book it in Fleet as that agent, then approve it as an admin. Within a minute the lead's
**Viewings** panel shows *Car booked*, and its follow-up reads *Viewing Booked*. Cancel the
booking if it was only a test; the CRM then shows it as *Cancelled*.

---

## Updating later

```bash
# laptop
cd ~/projects/carbooking && git checkout main && git pull
rsync -avz --delete --exclude='node_modules/' --exclude='dist/' --exclude='.git/' \
  --exclude='.env*' --exclude='apps/api/storage/' --exclude='.whatsapp-auth/' \
  --exclude='apps/mobile/android/' --exclude='apps/mobile/ios/' \
  ~/projects/carbooking/ SERVER:/opt/clients/fleet/
ssh SERVER 'cd /opt/clients/fleet && docker compose -f docker-compose.prod.yml up -d --build'
```

Migrations apply themselves when the new API starts. A change to any `VITE_*` value only takes
effect through a rebuild, which `--build` does every time.

## Backups

The database and the photo volume are the two things that cannot be rebuilt. The CRM lost
its database with the Contabo box on 27 Oct, so copies are kept **off this server** too.
The scripts are in [deploy/backup/](../deploy/backup/).

| Where | What runs | Keeps |
|---|---|---|
| Server | `~/fleet-jobs/fleet-backup.sh` from the `deploy` user's crontab, at 03:30 server time (05:30 Nairobi). It writes to `~/backups/fleet/` and logs to `~/backups/fleet-backup.log`. | 14 days of database dumps and the 3 newest photo sets |
| Laptop | `~/.local/bin/fleet-pull-backups` from the systemd user timer `fleet-pull-backups.timer`, at 12:30, or at the next login if the laptop was off. It copies into `~/backups/fleet/` and never mirrors deletions. If the server can't be reached, for example because the Wi-Fi isn't back yet after waking up, it tries again every 5 minutes, up to 6 tries, then raises a desktop alert. It also raises an alert if no dump is newer than 2 days. | 30 days of dumps and the 3 newest photo sets |

Each dump is checked with `pg_restore --list` before it replaces anything, and old copies are
only pruned after a good new one exists. The scripts live outside `/opt/clients/fleet`,
because the deploy's `rsync --delete` would remove them from there.

Install or update them:

```bash
# server
scp deploy/backup/fleet-backup.sh SERVER:fleet-jobs/fleet-backup.sh
ssh SERVER 'chmod 755 ~/fleet-jobs/fleet-backup.sh; line="30 3 * * * \$HOME/fleet-jobs/fleet-backup.sh >> \$HOME/backups/fleet-backup.log 2>&1"; { crontab -l 2>/dev/null | grep -v fleet-backup.sh || true; echo "$line"; } | crontab -'

# laptop
install -m 755 deploy/backup/fleet-pull-backups ~/.local/bin/
install -m 644 deploy/backup/fleet-pull-backups.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now fleet-pull-backups.timer
```

Restore a dump into a fresh database with
`docker compose -f docker-compose.prod.yml exec -T db pg_restore -U fleet -d fleet --clean --if-exists < fleet_DATE.dump`,
and photos with
`docker run --rm -i -v fleet_storage:/data alpine tar xzf - -C /data < fleet-photos_DATE.tgz`.

## If something is wrong

| Symptom | Look at |
|---|---|
| `api` keeps restarting | `docker compose -f docker-compose.prod.yml logs api`: *Invalid environment* names the bad variable; *AUTH_MODE=dev is not allowed* means set `AUTH_MODE=entra` |
| The page loads but sign-in fails | `VITE_ENTRA_*` are baked in at build time: fix `.env`, then `up -d --build`. Check the redirect URI on the client registration |
| `502` on `/api/...` | `api` isn't healthy yet, or crashed: `ps`, then `logs api` |
| *The CRM did not answer* | The CRM app isn't on `dunhill-internal`: step 3's `docker network inspect` |
| Viewings don't reach the CRM | `logs worker | grep crm.push-viewings`; a 401 or 404 there means the step 6 token check fails |
| Photos fail to upload | `API_PUBLIC_URL` must end in `/api`, and `client_max_body_size` must be in both nginx files |
| The CRM or the ERP broke | `sudo nginx -t`, then `ls /etc/nginx/conf.d/`: only `fleet.conf` should be new |
