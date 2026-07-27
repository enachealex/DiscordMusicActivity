# DiscordMusicActivity

Discord activity app for shared voice-channel music playback with YouTube and Spotify.

## Local Development

From the repository root:

```bash
npm install
npm run install:all
```

Run both services:

```bash
npm run dev
```

Or run separately:

```bash
npm run dev --prefix server
npm run dev --prefix client
```

- Client: `http://localhost:5173`
- Server: `http://localhost:3001`

## Search Troubleshooting

If search fails locally, verify the backend is running first.

Quick check:

```bash
curl "http://localhost:3001/youtube/search?q=test"
```

If this endpoint is unreachable, start the server (`npm run dev --prefix server`) and try again.

## Android App

`mobile/` is a Capacitor shell that installs the live site as an Android app. It
ships no copy of the UI, so server deploys reach the app with no rebuild.

```bash
cd mobile/android && ./gradlew assembleDebug
```

See [mobile/README.md](mobile/README.md) for signing, icons, and known limits.

## Deployment Prep (DuckDNS)

DuckDNS + HTTPS prep assets are available in:

- `deployment/duckdns/README.md`
- `deployment/duckdns/duckdns-update.sh`
- `deployment/duckdns/Caddyfile.example`
