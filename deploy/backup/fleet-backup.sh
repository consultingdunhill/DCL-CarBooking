#!/usr/bin/env bash
# Nightly Fleet backup on the server: the database and the photo volume.
#
#   fleet-backup.sh [backup-dir]      (default ~/backups/fleet)
#
# Installed as ~/fleet-jobs/fleet-backup.sh (outside /opt/clients/fleet, which the
# deploy's rsync --delete would wipe) and run from the deploy user's crontab. The
# laptop copies the results off the server (fleet-pull-backups).
#
# Each file is written under a .partial name and checked before it replaces
# anything, and old copies are pruned only after a good new one exists, so a
# failing night never eats into the backups already there.
set -euo pipefail

BACKUP_DIR="${1:-$HOME/backups/fleet}"
APP_DIR=/opt/clients/fleet
KEEP_DUMP_DAYS=14
KEEP_PHOTO_SETS=3

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
cd "$APP_DIR"

stamp="$(date +%Y-%m-%d_%H%M)"
dump="$BACKUP_DIR/fleet_$stamp.dump"
photos="$BACKUP_DIR/fleet-photos_$stamp.tgz"
trap 'rm -f "$dump.partial" "$photos.partial"' EXIT

# Database. Restore with: pg_restore --clean --if-exists -U fleet -d fleet < file
docker compose -f docker-compose.prod.yml exec -T db pg_dump --format=custom --no-owner -U fleet fleet > "$dump.partial"
# A truncated or empty dump fails here instead of replacing good ones.
docker compose -f docker-compose.prod.yml exec -T db pg_restore --list < "$dump.partial" > /dev/null
mv "$dump.partial" "$dump"
echo "wrote $dump ($(du -h "$dump" | cut -f1))"

# Odometer and receipt photos. Read from the volume as root, then handed to this user.
docker run --rm -v fleet_storage:/data:ro -v "$BACKUP_DIR":/out alpine \
  sh -c "tar czf /out/$(basename "$photos").partial -C /data . && chown $(id -u):$(id -g) /out/$(basename "$photos").partial"
tar tzf "$photos.partial" > /dev/null
mv "$photos.partial" "$photos"
echo "wrote $photos ($(du -h "$photos" | cut -f1))"

find "$BACKUP_DIR" -maxdepth 1 -name 'fleet_*.dump' -mtime +"$((KEEP_DUMP_DAYS - 1))" -print -delete
ls -1t "$BACKUP_DIR"/fleet-photos_*.tgz | tail -n +"$((KEEP_PHOTO_SETS + 1))" | xargs -r rm -v
echo "$(find "$BACKUP_DIR" -maxdepth 1 -name 'fleet_*.dump' | wc -l) dump(s), $(find "$BACKUP_DIR" -maxdepth 1 -name 'fleet-photos_*.tgz' | wc -l) photo set(s) kept"
