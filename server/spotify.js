import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { randomBytes, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { io } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env'), quiet: true });

export const spotifyRouter = express.Router();

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// Minimal scopes required for Web Playback SDK
// If you need more, enable them in Spotify Dashboard first (Settings > Users and Access)
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

function basicAuth() {
  return Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

function proxiedThumb(url) {
  if (!url) return '';
  return `/media/thumb?src=${encodeURIComponent(url)}`;
}

// The redirect URI must be the same value used during both /login and /callback.
// The origin it is built from is validated at /login time and kept server-side with
// the sign-in (see pendingLogins), never read back from anything the browser sends
// to /callback.
function buildRedirectUri(origin) {
  return `${origin}/callback`;
}

// ---------------------------------------------------------------------------------
// Sign-in state
//
// The OAuth `state` is a random nonce and nothing else. What the callback needs to
// know (where to redirect, which page may receive the tokens by postMessage, which
// socket gets them) is decided at /login time from validated input and kept here,
// keyed by that nonce. The callback looks the nonce up and deletes it: single use,
// ten minutes, and an unknown or expired nonce gets a plain failure page.
//
// RESIDUAL RISK (left for the owner to decide): the tokens are also emitted to the
// Socket.IO socket named when the sign-in began, because that is how they reach the
// app when sign-in completes somewhere other than a popup of the page. Inside Discord
// the link opens outside the activity (system browser or a new tab), and everywhere else (web, Android shell, LAN Party
// frame) the app opens it with target="_blank" rel="noopener", so the sign-in window
// has no window.opener and the postMessage below reaches nobody — today the socket is
// the only delivery path in every context. Nothing ties that socket to the person who
// finishes the sign-in. An attacker can therefore connect a socket of their own, start a sign-in
// naming it (/spotify/login-url, or a /spotify/login link), and get the victim to open
// the resulting link. If the victim has authorised this Spotify app before, Spotify
// skips the consent screen, the victim sees only a page that closes, and the victim's
// access and refresh tokens are emitted to the attacker's socket. The cookie binding
// below does not stop this: when the victim opens a /spotify/login link, the cookie is
// set in the victim's own browser. What it does stop is a sign-in started in one
// browser being completed in another. Closing the gap needs the finishing browser to
// prove it belongs to the socket's owner (e.g. a code shown in the app and typed on
// the callback page, or PKCE with the verifier held by the app and the code exchanged
// by the app rather than here).
// ---------------------------------------------------------------------------------
const LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_LOGINS = 2000;
const LOGIN_COOKIE = 'spotify_oauth_state';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const SOCKET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// nonce -> { socketId, userId, origin, clientOrigin, cookieBound, exp }
const pendingLogins = new Map();

function sweepPendingLogins(now = Date.now()) {
  for (const [nonce, entry] of pendingLogins) {
    if (entry.exp <= now) pendingLogins.delete(nonce);
  }
}

// Expired sign-ins are also swept on every new one; this catches a quiet server.
setInterval(sweepPendingLogins, 60 * 1000).unref();

function rememberLogin(entry) {
  sweepPendingLogins();
  // Map iteration is insertion order, so the first key is the oldest sign-in.
  while (pendingLogins.size >= MAX_PENDING_LOGINS) {
    pendingLogins.delete(pendingLogins.keys().next().value);
  }
  const nonce = randomBytes(32).toString('base64url');
  pendingLogins.set(nonce, { ...entry, exp: Date.now() + LOGIN_TTL_MS });
  return nonce;
}

function takeLogin(nonce) {
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return null;
  const entry = pendingLogins.get(nonce);
  if (!entry) return null;
  pendingLogins.delete(nonce);
  return entry.exp > Date.now() ? entry : null;
}

// --- Origin allowlist -------------------------------------------------------------

function toOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(origin) {
  const { hostname } = new URL(origin);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// The origin this request reached, as the browser saw it. Behind Caddy/Cloudflare the
// scheme arrives in X-Forwarded-Proto. Both headers are client-controlled when the
// server is reached directly, which is harmless here: they only ever add an origin the
// requester itself is using — Spotify still refuses a redirect_uri that is not
// registered, and the popup's tokens go only to a browser holding the /login cookie.
function requestOrigin(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : req.protocol;
  const host = req.get('host');
  return host ? toOrigin(`${proto}://${host}`) : null;
}

// Origins this server is published under: CLIENT_URL (comma-separated allowed), the
// origin of SPOTIFY_REDIRECT_URI, and the origin of the current request.
function ownOrigins(req) {
  const origins = new Set();
  for (const value of String(process.env.CLIENT_URL || '').split(',')) {
    const origin = toOrigin(value.trim());
    if (origin) origins.add(origin);
  }
  const redirectOrigin = toOrigin(process.env.SPOTIFY_REDIRECT_URI);
  if (redirectOrigin) origins.add(redirectOrigin);
  const reqOrigin = requestOrigin(req);
  if (reqOrigin) origins.add(reqOrigin);
  return origins;
}

// Inside Discord the page runs at https://<application id>.discordsays.com, Discord's
// proxy in front of this server, so that is the page origin a Discord sign-in names.
// The last fallback is the same public application id the client ships with
// (client/src/App.jsx): production's .env sets neither variable, and without it a
// sign-in started inside Discord would be refused as coming from an unknown page.
const BUILT_IN_DISCORD_APP_ID = '1492382387139772476';
function discordProxyOrigin() {
  const id = process.env.DISCORD_CLIENT_ID || process.env.VITE_DISCORD_CLIENT_ID || BUILT_IN_DISCORD_APP_ID;
  return id && /^[0-9]{5,32}$/.test(id) ? `https://${id}.discordsays.com` : null;
}

// `origin` builds the redirect_uri; it has to be this server.
function allowedRedirectOrigin(value, req) {
  const origin = toOrigin(value);
  if (!origin) return null;
  return ownOrigins(req).has(origin) || isLoopbackOrigin(origin) ? origin : null;
}

// `client_origin` is the page that started the sign-in: this server, or this app's
// Discord proxy origin.
function allowedClientOrigin(value, req) {
  const origin = toOrigin(value);
  if (!origin) return null;
  if (ownOrigins(req).has(origin) || isLoopbackOrigin(origin)) return origin;
  return origin === discordProxyOrigin() ? origin : null;
}

function firstQueryString(value) {
  return typeof value === 'string' ? value : '';
}

// Validates the query of /login and /login-url. Returns { error } or the entry.
function readLoginRequest(req) {
  const fallbackOrigin = toOrigin(String(process.env.CLIENT_URL || '').split(',')[0].trim())
    || 'http://localhost:5173';
  const rawOrigin = firstQueryString(req.query.origin) || fallbackOrigin;
  const origin = allowedRedirectOrigin(rawOrigin, req);
  if (!origin) return { error: 'origin is not allowed' };
  const rawClientOrigin = firstQueryString(req.query.client_origin) || origin;
  const clientOrigin = allowedClientOrigin(rawClientOrigin, req);
  if (!clientOrigin) return { error: 'client_origin is not allowed' };
  const socketId = firstQueryString(req.query.socketId);
  if (socketId && !SOCKET_ID_PATTERN.test(socketId)) return { error: 'socketId is malformed' };
  const userId = firstQueryString(req.query.userId).slice(0, 128);
  return { socketId, userId, origin, clientOrigin };
}

function spotifyAuthorizeUrl(origin, nonce) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: buildRedirectUri(origin),
    state: nonce,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

function readCookie(req, name) {
  const header = req.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function loginCookie(value, { origin, maxAge }) {
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  return `${LOGIN_COOKIE}=${value}; Max-Age=${maxAge}; Path=/callback; HttpOnly; SameSite=Lax${secure}`;
}

// Redirect the browser to Spotify. This is the link the app shows (opened in a new
// tab/window, or in the system browser from Discord), so this browser is also the one
// Spotify sends back to /callback: the sign-in is bound to it with a cookie.
spotifyRouter.get('/login', (req, res) => {
  const login = readLoginRequest(req);
  if (login.error) return res.status(400).type('text/plain').send(`Spotify sign-in refused: ${login.error}`);
  const nonce = rememberLogin({ ...login, cookieBound: true });
  res.set('Cache-Control', 'no-store');
  res.append('Set-Cookie', loginCookie(nonce, { origin: login.origin, maxAge: LOGIN_TTL_MS / 1000 }));
  res.redirect(spotifyAuthorizeUrl(login.origin, nonce));
});

// Return the Spotify login URL as JSON, for a caller that opens it somewhere this
// request's cookies do not reach (Discord SDK openExternalLink → system browser).
// There is no cookie binding; the tokens reach the app over the socket named here.
spotifyRouter.get('/login-url', (req, res) => {
  const login = readLoginRequest(req);
  if (login.error) return res.status(400).json({ error: login.error });
  const nonce = rememberLogin({ ...login, cookieBound: false });
  res.set('Cache-Control', 'no-store');
  res.json({ url: spotifyAuthorizeUrl(login.origin, nonce) });
});

  // Proxy search so the API key is never exposed to the client
  spotifyRouter.get('/search', async (req, res) => {
    const { q, access_token } = req.query;
    if (!q || !access_token) return res.status(400).json({ error: 'q and access_token required' });

    try {
      const { data } = await axios.get('https://api.spotify.com/v1/search', {
        params: { q, type: 'track', limit: 25 },
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const tracks = data.tracks.items.map((track) => ({
        id: track.uri,
        title: track.name,
        artist: track.artists.map((a) => a.name).join(', '),
        thumbnail: proxiedThumb(track.album.images[1]?.url || track.album.images[0]?.url),
        duration: track.duration_ms,
        service: 'spotify',
      }));
      res.json(tracks);
  } catch (err) {
    console.error('Spotify search error:', err.response?.data);
    res.status(500).json({ error: 'Spotify search failed' });
  }
});

// Refresh an expired Spotify access token
spotifyRouter.post('/refresh', async (req, res) => {
  // Express 5 leaves req.body undefined when no body was parsed (4 gave {}).
  const { refresh_token } = req.body ?? {};
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

  try {
    const { data } = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token }),
      {
        headers: {
          Authorization: `Basic ${basicAuth()}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    const body = { access_token: data.access_token, expires_in: data.expires_in };
    if (data.refresh_token) body.refresh_token = data.refresh_token;
    res.json(body);
  } catch (err) {
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// JSON that is safe inside an inline <script>: no "</script>", "<!--" or line
// terminators JavaScript treats differently from JSON.
function scriptJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function sendCallbackFailure(res, status, message) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.status(status).type('text/plain').send(`${message}\n\nClose this window and start the Spotify sign-in again from Music DJ.`);
}

// Handles the OAuth callback from Spotify (mounted at /callback in index.js)
export async function handleSpotifyCallback(req, res) {
  const { code, state } = req.query;
  // Consumed before anything else, so a nonce is spent even when Spotify reports an
  // error (the user pressed Cancel) and can never be replayed.
  const login = takeLogin(state);
  // The cookie is scoped to /callback and only needed once; clear it either way.
  if (login?.cookieBound || readCookie(req, LOGIN_COOKIE) !== null) {
    res.append('Set-Cookie', loginCookie('', { origin: login?.origin || requestOrigin(req) || 'http:', maxAge: 0 }));
  }
  if (!login) return sendCallbackFailure(res, 400, 'This Spotify sign-in link has expired or was already used.');
  if (login.cookieBound && !sameSecret(readCookie(req, LOGIN_COOKIE), state)) {
    return sendCallbackFailure(res, 400, 'This Spotify sign-in was not started in this browser, or a newer sign-in replaced it.');
  }
  if (typeof code !== 'string' || !code) return sendCallbackFailure(res, 400, 'Spotify did not authorise the sign-in.');

  const { origin, clientOrigin, socketId } = login;

  try {
    const { data } = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: buildRedirectUri(origin),
      }),
      {
        headers: {
          Authorization: `Basic ${basicAuth()}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const payloadObj = {
      type: 'spotify-auth',
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    };
    // Deliver to the socket recorded when this sign-in began (never one named by the
    // callback request). See RESIDUAL RISK above.
    if (socketId && io) {
      io.to(socketId).emit('spotify-auth', payloadObj);
    }
    // Both values were fixed server-side at /login; scriptJson() keeps them inert
    // anyway, and the CSP allows only this one script.
    const scriptNonce = randomBytes(16).toString('base64');
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`);
    res.type('html').send(`<!DOCTYPE html><html><head><title>Connecting to Spotify...</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#121212;color:#fff;}p{font-size:16px;}</style>
</head><body><p>Connecting to Spotify...</p><script nonce="${scriptNonce}">
try{window.opener&&window.opener.postMessage(${scriptJson(payloadObj)},${scriptJson(clientOrigin)});}finally{window.close();}
</script></body></html>`);
  } catch (err) {
    console.error('Spotify callback error:', err.response?.data);
    sendCallbackFailure(res, 500, 'Spotify authentication failed.');
  }
}
