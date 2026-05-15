# DuckDNS Deployment Prep

This folder contains a ready-to-run checklist and templates for hosting DiscordMusicActivity with:
- DuckDNS dynamic DNS
- Caddy reverse proxy + HTTPS
- PM2 process management

## Assumptions

- App server is running on `http://127.0.0.1:3001`
- Linux host has `pm2` and Node installed
- Router supports port forwarding

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

## 5) Keep App Process Alive (PM2)

```bash
pm2 start server/index.js --name discord-music --cwd ~/apps/DiscordMusicActivity
pm2 save
pm2 startup
```

Run the command PM2 prints, then `pm2 save` again.

## 6) Verification

```bash
curl -I http://127.0.0.1:3001
curl -I https://discordmusic.thejumpvault.com
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
