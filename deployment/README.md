# Deployment & Recovery — DiscordMusicActivity

How the app is **actually** hosted in production, and how to recover it when it goes down.

> The `duckdns/` subfolder documents an alternative Caddy + DuckDNS approach that is
> **not** what runs in production. The live server uses a **Cloudflare Tunnel**. Prefer
> this file.

---

## Live architecture

```
Discord client / browser
        │  https://discordmusic.thejumpvault.com
        ▼
   Cloudflare edge
        │  (Cloudflare named tunnel: "discord-music-activity")
        ▼
   cloudflared (PM2: discordmusic-tunnel)  ──►  http://127.0.0.1:3001
                                                     │
                                                     └── PM2: discord-music (Node/Express + Socket.IO)
```

- **Host:** the home server, `huckleberry@192.168.1.33` (key `~/.ssh/id_ed25519`). App lives at
  `/srv/apps/discord-music`. **`HOMELAB-SERVER.md` is canonical for the box itself** — storage
  layout, port map, and gotchas — read it before changing anything there.
- **App process:** PM2 process `discord-music`, port `3001` (see `ecosystem.config.cjs`).
- **Edge/ingress:** a **dedicated** Cloudflare named tunnel `discord-music-activity`, run by
  PM2 process `discordmusic-tunnel` with config `~/.cloudflared/discordmusic.yml`. DNS
  `discordmusic.thejumpvault.com` is a CNAME to that tunnel.
- The box also runs unrelated apps (`retroboard-*`, `vaultline`, `lan-party`, Docker projects)
  and their own tunnels. **Leave those alone.**
- **Media:** `yt-dlp` must be on PATH for YouTube audio extraction — `sudo apt-get install -y yt-dlp`.

> **The old host `192.168.1.2` / `romokid64` is retired and being reimaged.** Anything that still
> points there is stale; fix the reference rather than following it. Deploying there reaches no
> users — the tunnel is served from the home server now.

> **One connector per tunnel UUID.** Two machines running the same tunnel get round-robined by
> Cloudflare, which produces intermittent, hostname-specific 502s and "my deploy didn't show up"
> — during the August 2026 migration both hosts ran it and traffic silently split between two
> different builds. Stop the old connector before starting a new one.

`~/.cloudflared/discordmusic.yml` on the server:

```yaml
tunnel: 83dd9b7b-5cdc-4864-8d41-cd0fe42a20bb
credentials-file: /home/huckleberry/.cloudflared/83dd9b7b-5cdc-4864-8d41-cd0fe42a20bb.json

ingress:
  - hostname: discordmusic.thejumpvault.com
    service: http://127.0.0.1:3001
  - service: http_status:404
```

---

## Cloudflare Error 1033 / HTTP 530 — what it means here

Both mean **Cloudflare's edge has no working tunnel origin** for the hostname. The app on
`:3001` can be perfectly healthy and you still get 1033/530 if:

1. **The tunnel process isn't running** (most common) — nothing is serving the tunnel the DNS
   points at, so there's no origin.
2. **DNS points at the wrong/empty tunnel** — there are multiple tunnels on this box; the
   `discordmusic` CNAME must target `discord-music-activity` (`83dd9b7b…`).
3. **Stale/duplicate connectors** — leftover `cloudflared` processes (e.g. an old
   `cloudflared tunnel --url …` quick tunnel) register competing connectors; the edge routes
   onto a dead one. Keep exactly one connector per intended tunnel.
4. **The Node app crash-looped** so nothing listens on `:3001` (check `server/node_modules`
   exists and `pm2 list` restart count).

It is **not** a generic DNS-record problem in normal operation — don't switch the record to an
A record or change proxy settings. Fix the tunnel/app.

---

## Fast recovery

```bash
ssh -i ~/.ssh/id_ed25519 huckleberry@192.168.1.33
cd /srv/apps/discord-music
bash deployment/recover.sh       # pulls, installs, builds, restarts app+tunnel, health-checks
```

`recover.sh` is idempotent. Use `PULL=0 bash deployment/recover.sh` to skip the git pull.

Its last step resolves a real video and checks the bytes are `audio/*`, because `/health`
answers 200 whether or not playback works at all.

---

## Manual triage

```bash
# App healthy locally?
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/health      # want 200

# Public healthy?
curl -s -o /dev/null -w '%{http_code}\n' https://discordmusic.thejumpvault.com/health

# Playback specifically (search and /health stay green without yt-dlp):
which yt-dlp && yt-dlp --version
curl -s -o /dev/null -w '%{content_type}\n' -r 0-65535 \
  http://127.0.0.1:3001/youtube/audio/<videoId>   # want audio/*, not application/json

# If local=200 but public=530/1033: it's the tunnel.
pm2 describe discordmusic-tunnel | grep -iE 'status|restart'
pm2 logs discordmusic-tunnel --lines 30 --nostream | grep -iE 'Registered|ERR'
pgrep -af cloudflared                              # one connector per intended tunnel
cloudflared tunnel info discord-music-activity     # edge connection state

# Repoint DNS to the right tunnel if needed (only discordmusic, nothing else):
cloudflared tunnel route dns --overwrite-dns discord-music-activity discordmusic.thejumpvault.com
```

---

## First-time tunnel setup (one time, already done in prod)

```bash
# discordmusic.yml already exists; start it under PM2 and persist:
cd /srv/apps/discord-music
mkdir -p logs
pm2 start cloudflared --name discordmusic-tunnel -- tunnel --config ~/.cloudflared/discordmusic.yml run
pm2 start ecosystem.config.cjs        # the app itself
pm2 save
pm2 startup                            # run the printed command once, then: pm2 save
```

`ecosystem.config.cjs` configures the app: crash auto-restart with cooldown + min-uptime,
512 MB memory guard, daily 4 AM restart, and structured logs under `logs/`.

---

## Recommended: external uptime monitor

Add a free [UptimeRobot](https://uptimerobot.com) HTTP monitor:

- URL: `https://discordmusic.thejumpvault.com/health`
- Interval: 1 minute · Expect HTTP 200, body `{"status":"ok",...}`

So you hear about an outage before your Discord users do.
