#!/usr/bin/env bash
# Serve the production build from this machine at a temporary https://….trycloudflare.com address,
# so phones can install and test Fleet. The address changes every run. Needs cloudflared and the database.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v cloudflared >/dev/null || { echo "cloudflared isn't installed. See README → Try it on a phone."; exit 1; }
for port in 4000 4173; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "Port $port is in use. Stop pnpm dev (or an earlier pnpm share) first."; exit 1; fi
done

# Ctrl+C stops the tunnel, API, worker and web server together.
trap 'exit' INT TERM
trap 'trap - EXIT; kill 0' EXIT

# One address for app and API: the build calls /api on its own address, and `vite preview` passes it on.
VITE_API_URL=/api pnpm --filter @carbooking/web build

log=$(mktemp)
cloudflared tunnel --url http://localhost:4173 --http-host-header localhost:4173 >"$log" 2>&1 &
url=''
for _ in $(seq 60); do
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)
  [ -n "$url" ] && break
  sleep 1
done
[ -n "$url" ] || { cat "$log"; echo "cloudflared didn't give an address."; exit 1; }

# Photo links the API hands out must use the public address too.
API_PUBLIC_URL="$url/api" pnpm --parallel --filter @carbooking/api --filter @carbooking/worker dev &
pnpm --filter @carbooking/web preview &

sleep 5
printf '\n  Open on your phone: %s\n  (Ctrl+C to stop)\n\n' "$url"
wait
