# DuckDNS Deployment Prep

> **⚠️ Not the live setup.** Production does NOT use Caddy + DuckDNS. It runs behind a
> **Cloudflare Tunnel** (`cloudflared`). For the real architecture and how to recover from
> Cloudflare Error 1033 / HTTP 530, see [`../README.md`](../README.md). This folder is kept
> only as a reference for the alternative Caddy/DuckDNS approach.

This folder contains a ready-to-run checklist and templates for hosting DiscordMusicActivity with:
- DuckDNS dynamic DNS
- Caddy reverse proxy + HTTPS
- PM2 process management

## Assumptions

- App server is running on `http://127.0.0.1:3001`
- Linux host has `pm2` and Node installed
- Router supports port forwarding

---

## 1) DuckDNS Variables

Create a local shell file with your values:

```bash
export DUCKDNS_SUBDOMAIN="your-subdomain"
export DUCKDNS_TOKEN="your-duckdns-token"
```

## 2) Install DuckDNS Updater

Use the helper script in this folder:

```bash
chmod +x deployment/duckdns/duckdns-update.sh
./deployment/duckdns/duckdns-update.sh "$DUCKDNS_SUBDOMAIN" "$DUCKDNS_TOKEN"
```

This writes:
- `~/duckdns/duck.sh`
- cron job (every 5 minutes)

## 3) Router / Firewall

Forward these external ports to your Linux host:
- TCP 80
- TCP 443

## 4) Install Caddy and Apply Config

Use the template in this folder:
- `deployment/duckdns/Caddyfile.example`

Use `discordmusic.thejumpvault.com` in the host line and copy to `/etc/caddy/Caddyfile`.

Then run:

```bash
sudo systemctl restart caddy
sudo systemctl status caddy
```

## 5) Keep App Process Alive (PM2 with ecosystem config)

Use the `ecosystem.config.cjs` in the project root — it sets crash recovery, memory limits, and log rotation automatically:

```bash
# Create logs directory first
mkdir -p ~/apps/DiscordMusicActivity/logs

# Start with ecosystem config
cd ~/apps/DiscordMusicActivity
pm2 start ecosystem.config.cjs

# Save process list and enable boot startup
pm2 save
pm2 startup
# Run the command PM2 prints, then:
pm2 save
```

**If you previously started PM2 without the ecosystem config, delete the old process first:**
```bash
pm2 delete discord-music
pm2 start ecosystem.config.cjs
pm2 save
```

Key settings in the ecosystem config:
- Auto-restarts on crash with a 2 s cooldown
- Restarts if memory exceeds 512 MB (guards against leaks)
- Daily restart at 4 AM (clears any slow drift)
- Logs written to `logs/out.log` and `logs/error.log`

## 6) Verification

```bash
# Local server health
curl http://127.0.0.1:3001/health

# Through Caddy / Cloudflare
curl https://discordmusic.thejumpvault.com/health

# PM2 status
pm2 status
pm2 logs discord-music --lines 50
```

## 7) OAuth / App Mapping Targets

Once URL is live, set these to the same host:

- Discord Activity URL mapping: `https://discordmusic.thejumpvault.com`
- Spotify Redirect URI: `https://discordmusic.thejumpvault.com/callback`
- App `.env`:
  - `CLIENT_URL=https://discordmusic.thejumpvault.com`
  - `VITE_SERVER_URL=https://discordmusic.thejumpvault.com`
  - `SPOTIFY_REDIRECT_URI=https://discordmusic.thejumpvault.com/callback`

Rebuild client and restart app after `.env` updates:

```bash
npm run build --prefix client
pm2 restart discord-music
```

## 8) Optional: External uptime monitor

Use a free service like UptimeRobot or Better Uptime to ping `/health` every 1 minute.
This catches outages before users notice and gives you an alert so you can restart manually if PM2 doesn't recover.

Monitor URL: `https://discordmusic.thejumpvault.com/health`
Expected response: HTTP 200 with `{"status":"ok",...}`
