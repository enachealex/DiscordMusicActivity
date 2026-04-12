import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { io } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

export const spotifyRouter = express.Router();

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'streaming',
  'user-read-email',
  'user-read-private',
].join(' ');

function basicAuth() {
  return Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

function proxiedThumb(url) {
  if (!url) return '';
  return `/media/thumb?src=${encodeURIComponent(url)}`;
}

// The redirect URI must be the same value used during both /login and /callback.
// We encode the client origin in the OAuth state so callback can reconstruct it.
function buildRedirectUri(origin) {
  return `${origin}/callback`;
}

// Redirect user to Spotify login
spotifyRouter.get('/login', (req, res) => {
  // Client passes its own window.location.origin so we always use the correct URL
  const origin = req.query.origin || process.env.CLIENT_URL || 'http://localhost:5173';
  const clientOrigin = req.query.client_origin || origin;
  const socketId = req.query.socketId || '';
  const state = JSON.stringify({ userId: req.query.userId || '', socketId, origin, clientOrigin });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: buildRedirectUri(origin),
    state,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// Proxy search so the API key is never exposed to the client
spotifyRouter.get('/search', async (req, res) => {
  const { q, access_token } = req.query;
  if (!q || !access_token) return res.status(400).json({ error: 'q and access_token required' });

  try {
    const { data } = await axios.get('https://api.spotify.com/v1/search', {
      params: { q, type: 'track', limit: 10 },
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
  const { refresh_token } = req.body;
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

// Handles the OAuth callback from Spotify (mounted at /callback in index.js)
export async function handleSpotifyCallback(req, res) {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');

  // Recover the origin we encoded in state during /login
  let origin = process.env.CLIENT_URL || 'http://localhost:5173';
  let clientOrigin = origin;
  let socketId = '';
  try {
    const parsed = JSON.parse(state || '{}');
    if (parsed.origin) origin = parsed.origin;
    if (parsed.clientOrigin) clientOrigin = parsed.clientOrigin;
    if (parsed.socketId) socketId = parsed.socketId;
  } catch { /* state may be a plain userId string from old sessions */ }

  try {
    const { data } = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
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
    const payload = JSON.stringify(payloadObj);

    // If we have a socketId (likely from an embedded app context), send the token to it directly
    if (socketId && io) {
      io.to(socketId).emit('spotify-auth', payloadObj);
    }
    res.send(`<!DOCTYPE html><html><head><title>Connecting to Spotify...</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#121212;color:#fff;}p{font-size:16px;}</style>
</head><body><p>Connecting to Spotify...</p><script>
try{window.opener&&window.opener.postMessage(${payload},${JSON.stringify(clientOrigin)});}finally{window.close();}
</script></body></html>`);
  } catch (err) {
    console.error('Spotify callback error:', err.response?.data);
    res.status(500).send('Spotify authentication failed');
  }
}