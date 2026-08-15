#!/usr/bin/env bash
#
# recover.sh — Bring DiscordMusicActivity back online after a crash or outage.
#
# Run this when the site is down (e.g. Cloudflare Error 1033 / HTTP 530). Safe to
# run repeatedly. Pulls latest code, reinstalls deps, rebuilds the client,
# (re)starts the app AND its Cloudflare tunnel under PM2, then health-checks.
#
# Architecture (see deployment/README.md):
#   browser -> Cloudflare edge -> cloudflared "discord-music-activity" tunnel
#           -> http://127.0.0.1:3001 (PM2 "discord-music")
#   The tunnel runs as PM2 process "discordmusic-tunnel"
#   (cloudflared tunnel --config ~/.cloudflared/discordmusic.yml run).
#
# Error 1033/530 almost always means the tunnel process is down (its origin app
# may be perfectly healthy). recover.sh restarts both.
#
# Usage (on the server):
#   cd /srv/apps/discord-music && bash deployment/recover.sh
#   PULL=0 bash deployment/recover.sh   # skip git pull (keep local changes)
#
set -euo pipefail

# Home server (192.168.1.33, user huckleberry). See HOMELAB-SERVER.md for the box
# itself. The previous host, 192.168.1.2 / romokid64, is retired — do not use it.
APP_DIR="${APP_DIR:-/srv/apps/discord-music}"
DOMAIN="${DOMAIN:-discordmusic.thejumpvault.com}"
PORT="${PORT:-3001}"
TUNNEL_PROC="${TUNNEL_PROC:-discordmusic-tunnel}"
PULL="${PULL:-1}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  OK %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m  !! %s\033[0m\n' "$*"; }

cd "$APP_DIR"

if [ "$PULL" = "1" ]; then
  say "1/7  Fetching latest code"
  git fetch --all --prune
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  git reset --hard "origin/${CURRENT_BRANCH}"
  ok "Now at $(git rev-parse --short HEAD) on ${CURRENT_BRANCH}"
else
  warn "1/7  PULL=0 set — skipping git pull, using working tree as-is"
fi

say "2/7  Installing server dependencies"
npm --prefix server install --no-audit --no-fund
ok "Server deps installed"

say "3/7  Installing client dependencies"
npm --prefix client install --no-audit --no-fund
ok "Client deps installed"

say "4/7  Building client"
npm run build --prefix client
ok "Client built to client/dist"

say "5/7  Ensuring logs directory and verifying yt-dlp"
mkdir -p "$APP_DIR/logs"
if command -v yt-dlp >/dev/null 2>&1; then
  ok "yt-dlp present: $(yt-dlp --version 2>/dev/null || echo unknown)"
else
  # This exact gap took audio down after the 2026-08 server migration: the app
  # moved, yt-dlp didn't, and every check except playback stayed green.
  warn "yt-dlp NOT found on PATH — ALL playback will fail (search and /health stay green)."
  warn "Install it:  sudo apt-get install -y yt-dlp"
fi

say "6/7  (Re)starting app + tunnel under PM2"
if [ -f "$APP_DIR/ecosystem.config.cjs" ]; then
  pm2 delete discord-music >/dev/null 2>&1 || true
  pm2 start "$APP_DIR/ecosystem.config.cjs"
else
  warn "ecosystem.config.cjs missing — using a basic start"
  pm2 delete discord-music >/dev/null 2>&1 || true
  pm2 start server/index.js --name discord-music --cwd "$APP_DIR" \
    --max-memory-restart 512M --restart-delay 2000
fi
# Restart the Cloudflare tunnel if it already exists (Error 1033/530 is usually a
# dead tunnel, not a dead app). We don't create it here — it's a one-time setup
# documented in deployment/README.md — but a restart clears stale connectors.
if pm2 describe "$TUNNEL_PROC" >/dev/null 2>&1; then
  pm2 restart "$TUNNEL_PROC" >/dev/null 2>&1 || true
  ok "Restarted tunnel process '$TUNNEL_PROC'"
else
  warn "Tunnel process '$TUNNEL_PROC' not found in PM2 — see deployment/README.md to set it up"
fi
pm2 save
ok "PM2 processes started and saved"

say "7/7  Health check"
sleep 3
LOCAL_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health" || echo 000)"
if [ "$LOCAL_CODE" = "200" ]; then
  ok "Local health OK (http://127.0.0.1:${PORT}/health -> 200)"
else
  warn "Local health returned ${LOCAL_CODE} — the app is down. Recent error log:"
  pm2 logs discord-music --err --lines 20 --nostream || true
fi

PUBLIC_CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAIN}/health" || echo 000)"
if [ "$PUBLIC_CODE" = "200" ]; then
  ok "Public health OK (https://${DOMAIN}/health -> 200)"
elif [ "$LOCAL_CODE" = "200" ]; then
  warn "Local is up but public returned ${PUBLIC_CODE} — the app is fine, so check the tunnel:"
  echo "    pm2 logs ${TUNNEL_PROC} --lines 30 --nostream | grep -iE 'Registered|ERR'"
  echo "    pgrep -af cloudflared   # exactly one connector per intended tunnel"
  echo "    cloudflared tunnel info discord-music-activity"
else
  warn "Public health returned ${PUBLIC_CODE} (app also down — fix the app first; see log above)."
fi

say "8/8  Playback check (the part /health cannot see)"
# /health returns 200 with no yt-dlp, no audio, and an empty queue, so it has been
# a false all-clear here. Resolve a real video through the app and confirm the
# bytes coming back are actually audio.
PROBE_ID="$(curl -s --max-time 20 "http://127.0.0.1:${PORT}/youtube/search?q=lofi" \
  | sed -n 's/.*"id":"\([A-Za-z0-9_-]\{6,20\}\)".*/\1/p' | head -1 || true)"
if [ -z "$PROBE_ID" ]; then
  warn "Could not get a video id from search — skipping playback check (YOUTUBE_API_KEY set?)"
else
  AUDIO_TYPE="$(curl -s -o /dev/null -w '%{content_type}' --max-time 60 -r 0-65535 \
    "http://127.0.0.1:${PORT}/youtube/audio/${PROBE_ID}" || true)"
  case "$AUDIO_TYPE" in
    audio/*) ok "Playback OK (${PROBE_ID} -> ${AUDIO_TYPE})" ;;
    *)       warn "Playback BROKEN — /youtube/audio returned '${AUDIO_TYPE:-nothing}', not audio."
             warn "Most likely yt-dlp is missing, too old, or being refused by YouTube." ;;
  esac
fi

say "Done. Current PM2 status:"
pm2 list
