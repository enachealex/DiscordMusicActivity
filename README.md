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

## Spotify sign-in

`/spotify/login` (the link the app shows) and `/spotify/login-url` start a sign-in. The
OAuth `state` is a random single-use nonce; everything else about the sign-in is kept on
the server for 10 minutes. `/spotify/login` also binds the sign-in to the browser that
opened it with a cookie, so `/callback` must be reached in that same browser. The tokens
reach the app over its Socket.IO connection (and by `postMessage` to the opening page,
when there is one).

The `origin` (used for Spotify's redirect URI) and `client_origin` (the app page) a
sign-in names must be one of: an origin in `CLIENT_URL` (comma-separated list allowed),
the origin of `SPOTIFY_REDIRECT_URI`, the origin the request itself arrived on,
`localhost`/`127.0.0.1` on any port, or — for `client_origin` only — this app's Discord
proxy origin `https://<DISCORD_CLIENT_ID>.discordsays.com`. Anything else is refused. If
you develop through a tunnel, add the tunnel's origin to `CLIENT_URL` (and register
`<tunnel>/callback` as a redirect URI in the Spotify dashboard).

## LAN Party mode

The site can also run inside a [LAN Party](https://lanparty.thejumpvault.com) voice
channel as a hosted app. LAN Party frames it with `?lanparty=1` and tells it, over
`postMessage`, who is looking and an opaque id for the voice channel. Everyone who opens
the app in that channel lands in the same queue (room `lanparty:<id>`), signed in under
their LAN Party name, with no login step. Like a Discord voice channel's, the queue
belongs to the channel and is still there after everyone has left. Opened on its own in
LAN Party (no channel) it is a private solo session.

LAN Party mode is entered only when all three hold; otherwise the page behaves as the
ordinary website:

1. the page is framed,
2. the address has `lanparty=1`,
3. the bridge handshake is answered within about 3 seconds by a page on an allowed origin.

**`VITE_LANPARTY_ORIGINS`** is that allowlist: comma-separated origins, read from the
root `.env` when the client is **built** (not at runtime). Unset or empty means
`https://lanparty.thejumpvault.com`; a dev build (`npm run dev`) also accepts
`http://localhost:3000`. This list is the whole trust decision — any page can frame the
site and add `?lanparty=1`, but only a listed origin can complete the handshake — so the
host origin is never taken from the address or from a message. Changing it means
rebuilding the client. If the app opens inside LAN Party but as a private web session
rather than the channel's queue, the browser console says which origins this build
accepts — the LAN Party it was framed by is not one of them.

What the bridge tells the app is the listener's **public LAN Party name**, not proof of
who they are: nothing is signed, and the server takes the name on trust exactly as it
takes a web visitor's. The channel id is the only thing guarding a `lanparty:` room, in
the same way a Listen Together code guards a party. The server accepts a `lanparty:` key
only in the exact shape LAN Party issues (32 lowercase hex characters).

The bridge SDK is **vendored**: `client/src/vendor/lanparty.js` is a copy of LAN Party's
`server/sdk/lanparty.js` under a short header, loaded only in LAN Party mode. It is not
fetched from LAN Party at runtime because this origin holds listeners' Spotify tokens and
should run no script it did not ship. To refresh it after the SDK changes upstream,
replace everything below the marker line in that file with the new
`server/sdk/lanparty.js`, then rebuild and check the handshake still works:

```bash
npm --prefix client run build
```

The glue is `client/src/lanParty.js` (the handshake and the allowlist) and the init
effect in `client/src/App.jsx`. The site must stay frameable by the allowed origins: it
sends no `X-Frame-Options` or `frame-ancestors` today, and if a framing policy is ever
added it has to allow those origins alongside Discord's.

### Developing against a local LAN Party

Both projects' Vite dev servers default to port **5173**, and neither pins it
(`strictPort` is off), so whichever starts second silently moves to 5174 — and the
Discord activity's dev tunnel, LAN Party's registered app address, or your browser
tab may then be pointing at the wrong app. The supported setup avoids LAN Party's
Vite entirely:

1. **LAN Party**: build its client and run its server, which serves the built client on
   `http://localhost:3000` (in the LAN Party repo: build the client, then start the
   server; do not run its `npm run dev` client).
2. **Music DJ**: `npm run dev` here — Vite on `http://localhost:5173`, the API on
   `http://localhost:3001`. Register the hosted app in LAN Party with the origin
   `http://localhost:5173`.

A dev build accepts `http://localhost:3000` as a LAN Party host automatically. For any
other arrangement (LAN Party's own Vite dev server, another port, a LAN address), set
the origin it is served from in the root `.env` and **restart** Music DJ's Vite, which
reads `.env` only at startup:

```bash
# LAN Party's client served from its Vite dev server on 5174, say
VITE_LANPARTY_ORIGINS=http://localhost:5174
```

The value replaces the production default (`https://lanparty.thejumpvault.com`) for
that build; a dev build still adds `http://localhost:3000` on top. Remove it again
before building for production, or the production bundle will accept only that origin.

### Known limits inside LAN Party

- **Spotify playback does not work in the LAN Party Windows desktop app.** Spotify's Web
  Playback SDK needs Widevine DRM, and the desktop app is stock Electron, which ships
  without Widevine, so Spotify tracks will not play there. **YouTube works** in the
  desktop app. For Spotify, open LAN Party in a regular browser such as Chrome or Edge.

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
