import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { randomBytes, randomInt, timingSafeEqual } from 'crypto';
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
// know (where to redirect, which socket started the sign-in) is decided at /login
// time from validated input and kept here, keyed by that nonce. The callback looks
// the nonce up and deletes it: single use, ten minutes, and an unknown or expired
// nonce gets a plain failure page.
//
// Finishing at Spotify does not deliver the tokens. The sign-in link is opened away
// from the app in every context (the system browser from Discord; a new tab with
// rel="noopener" on the web, in the Android shell and in the LAN Party frame), so
// nothing ties the browser that reaches /callback to the app whose socket started the
// sign-in. Emitting the tokens to that socket straight away let an attacker connect a
// socket, start a sign-in naming it, and send the link to someone who had authorised
// this Spotify app before: Spotify skips the consent screen and that person's access
// and refresh tokens went to the attacker's socket. The /login cookie does not stop
// that, because it is set in the victim's own browser when they open the link; all it
// stops is a sign-in started in one browser being completed in another.
//
// So the callback keeps the tokens here (pendingConfirmations) and shows a 6-digit
// code instead. The app that started the sign-in asks for the code and sends it over
// its socket ('spotify-auth:confirm'); only a match releases the tokens, and only to
// the socket recorded at /login. Held tokens are dropped after five minutes, after
// five wrong codes, when a newer sign-in for the same socket completes, and when the
// socket disconnects.
//
// RESIDUAL RISK: the code is now the whole of the proof. A victim who opens an
// attacker's link sees their own code on their own screen, next to a warning; the
// attacker gets the tokens only if the victim then reads that code out to them (or
// types it wherever the attacker says), so the attack needs a second, deliberate step
// from the victim instead of one click. Guessing is five tries in a million per
// sign-in the victim completes. The mirror case also remains: someone who types a
// code another person gave them connects their app to that other person's Spotify.
// ---------------------------------------------------------------------------------
const LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_LOGINS = 2000;
const CONFIRM_TTL_MS = 5 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const LOGIN_COOKIE = 'spotify_oauth_state';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const SOCKET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_PATTERN = /^[0-9]{6}$/;

// nonce -> { socketId, userId, origin, clientOrigin, exp }
const pendingLogins = new Map();

// socketId -> { code, tokens, attempts, exp }: sign-ins Spotify has completed, waiting
// for their code. Keyed by socket so there is one per socket (a newer one replaces
// it), and so a confirmation can only ever look up the sender's own entry.
const pendingConfirmations = new Map();

function sweepPendingLogins(now = Date.now()) {
  for (const [nonce, entry] of pendingLogins) {
    if (entry.exp <= now) pendingLogins.delete(nonce);
  }
  for (const [socketId, entry] of pendingConfirmations) {
    if (entry.exp <= now) pendingConfirmations.delete(socketId);
  }
}

// Expired sign-ins are also swept on every new one; this catches a quiet server, and
// is what gets expired tokens out of memory when nobody ever sends a code for them.
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

function socketConnected(socketId) {
  return !!io?.sockets.sockets.has(socketId);
}

// Keep a completed sign-in's tokens until its socket confirms the code. Returns the
// code to show on the callback page.
function holdTokens(socketId, tokens) {
  sweepPendingLogins();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  pendingConfirmations.set(socketId, { code, tokens, attempts: 0, exp: Date.now() + CONFIRM_TTL_MS });
  return code;
}

// The answer to 'spotify-auth:confirm'. `message` is shown to the user as it is.
function confirmSignIn(socket, rawCode) {
  const refused = (reason, message, extra) => ({ ok: false, reason, message, ...extra });
  const pending = pendingConfirmations.get(socket.id);
  if (!pending) {
    return refused('none', 'No Spotify sign-in is waiting for a code. It may have expired, or Music DJ reconnected since you started. Start again.');
  }
  if (pending.exp <= Date.now()) {
    pendingConfirmations.delete(socket.id);
    return refused('expired', 'That code has expired. Start the Spotify sign-in again.');
  }
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  // A slip of the finger, not a guess: it could never match, so it costs no attempt.
  if (!CODE_PATTERN.test(code)) return refused('invalid', 'Enter the 6-digit code shown on the Spotify page.');
  if (!sameSecret(code, pending.code)) {
    pending.attempts += 1;
    if (pending.attempts >= MAX_CODE_ATTEMPTS) {
      pendingConfirmations.delete(socket.id);
      return refused('too-many-attempts', 'Too many wrong codes. Start the Spotify sign-in again.');
    }
    const attemptsLeft = MAX_CODE_ATTEMPTS - pending.attempts;
    return refused('wrong-code', `That code is not right. ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.`, { attemptsLeft });
  }
  pendingConfirmations.delete(socket.id);
  socket.emit('spotify-auth', pending.tokens);
  return { ok: true };
}

// Called for every new socket (index.js). The handlers read socket.id themselves, so
// a confirmation cannot name anyone else's sign-in.
export function attachSpotifySignIn(socket) {
  socket.on('spotify-auth:confirm', (payload, reply) => {
    // Socket.IO puts the acknowledgement last, wherever that is.
    const ack = typeof payload === 'function' ? payload : reply;
    const result = confirmSignIn(socket, payload?.code);
    if (typeof ack === 'function') ack(result);
  });
  // Socket ids are never reused, so nobody could confirm this any more.
  socket.on('disconnect', () => {
    pendingConfirmations.delete(socket.id);
  });
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
// registered, and the tokens are released only to the socket that sends the code.
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
// Discord proxy origin. Nothing is sent to that page any more (the tokens travel over
// the socket); a sign-in naming a page that is not this app is still refused.
function allowedClientOrigin(value, req) {
  const origin = toOrigin(value);
  if (!origin) return null;
  if (ownOrigins(req).has(origin) || isLoopbackOrigin(origin)) return origin;
  return origin === discordProxyOrigin() ? origin : null;
}

function firstQueryString(value) {
  return typeof value === 'string' ? value : '';
}

// Validates the query of /login. Returns { error } or the entry.
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
  // The socket is the only way the tokens reach the app, and the only one that can
  // confirm the code. Without a live one the sign-in could never finish, so say so
  // now rather than after the user has been through Spotify.
  if (!socketConnected(socketId)) {
    return { error: 'this link is out of date (Music DJ has reconnected since it was made). Go back to Music DJ and use the link shown there.' };
  }
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
// Spotify sends back to /callback: the sign-in is bound to it with a cookie. It is the
// only way to start a sign-in.
spotifyRouter.get('/login', (req, res) => {
  const login = readLoginRequest(req);
  if (login.error) return res.status(400).type('text/plain').send(`Spotify sign-in refused: ${login.error}`);
  const nonce = rememberLogin(login);
  res.set('Cache-Control', 'no-store');
  res.append('Set-Cookie', loginCookie(nonce, { origin: login.origin, maxAge: LOGIN_TTL_MS / 1000 }));
  res.redirect(spotifyAuthorizeUrl(login.origin, nonce));
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

function sendCallbackFailure(res, status, message) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.status(status).type('text/plain').send(`${message}\n\nClose this window and start the Spotify sign-in again from Music DJ.`);
}

// The page that ends a sign-in in the browser. It carries the code and nothing else:
// no tokens, no script (the CSP allows none), and the only value interpolated is the
// six digits generated here. It stays open \u2014 the user has to read the code off it \u2014
// and may not be framed, so another site cannot show the code with the warning
// cropped away.
function sendCodePage(res, code) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Spotify code for Music DJ</title>
<style>
body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#121212;color:#fff;}
main{box-sizing:border-box;width:100%;max-width:440px;padding:24px 20px;text-align:center;}
p{font-size:16px;line-height:1.5;margin:0 0 16px;}
.code{font-family:monospace;font-size:44px;font-weight:700;letter-spacing:6px;margin:0 0 20px;padding:14px 8px;border-radius:12px;background:#1f1f1f;color:#1db954;user-select:all;}
.warn{text-align:left;padding:12px 14px;border-radius:10px;border:1px solid #b3261e;background:#2a1513;}
.note{font-size:13px;color:#b3b3b3;margin:0;}
</style>
</head><body><main>
<p>Type this code into Music DJ to finish connecting Spotify.</p>
<p class="code">${code}</p>
<p class="warn"><strong>Only do this if you started connecting Spotify yourself, just now.</strong> If someone sent you this link, close this page &mdash; entering the code in someone else's app would give them access to your Spotify. Never tell anyone this code.</p>
<p class="note">The code works for 5 minutes, in the Music DJ window that started this sign-in. You can close this page once Music DJ is connected.</p>
</main></body></html>`);
}

// Handles the OAuth callback from Spotify (mounted at /callback in index.js)
export async function handleSpotifyCallback(req, res) {
  const { code, state } = req.query;
  // Consumed before anything else, so a nonce is spent even when Spotify reports an
  // error (the user pressed Cancel) and can never be replayed.
  const login = takeLogin(state);
  // The cookie is scoped to /callback and only needed once; clear it either way.
  if (login || readCookie(req, LOGIN_COOKIE) !== null) {
    res.append('Set-Cookie', loginCookie('', { origin: login?.origin || requestOrigin(req) || 'http:', maxAge: 0 }));
  }
  if (!login) return sendCallbackFailure(res, 400, 'This Spotify sign-in link has expired or was already used.');
  if (!sameSecret(readCookie(req, LOGIN_COOKIE), state)) {
    return sendCallbackFailure(res, 400, 'This Spotify sign-in was not started in this browser, or a newer sign-in replaced it.');
  }
  if (typeof code !== 'string' || !code) return sendCallbackFailure(res, 400, 'Spotify did not authorise the sign-in.');

  // The socket recorded when this sign-in began, never one named by the callback
  // request. If it has gone there is nobody to type the code, so the authorization
  // code is left unspent and no tokens are ever made.
  const { origin, socketId } = login;
  const appGone = 'Music DJ is no longer connected in the window that started this sign-in.';
  if (!socketConnected(socketId)) return sendCallbackFailure(res, 409, appGone);

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

    // It may have gone while Spotify was answering; holding tokens for it then would
    // only leave them in memory until the sweep.
    if (!socketConnected(socketId)) return sendCallbackFailure(res, 409, appGone);
    // Nothing is emitted here. The tokens wait for the code (see "Sign-in state").
    const confirmCode = holdTokens(socketId, {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    });
    sendCodePage(res, confirmCode);
  } catch (err) {
    console.error('Spotify callback error:', err.response?.data);
    sendCallbackFailure(res, 500, 'Spotify authentication failed.');
  }
}
