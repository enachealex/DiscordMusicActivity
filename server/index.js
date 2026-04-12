import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spotifyRouter, handleSpotifyCallback } from './spotify.js';
import { youtubeRouter } from './youtube.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const app = express();
const httpServer = createServer(app);
export const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());

// In production the Vite dev proxy is gone, so /api/* → /* rewrite keeps
// client-side fetch paths like /api/discord/token working unchanged.
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) {
    req.url = '/' + req.url.slice(5); // strip leading '/api'
  }
  next();
});

// Spotify OAuth routes
app.use('/spotify', spotifyRouter);

// Spotify OAuth callback — must match the Redirect URI set in Spotify dashboard
app.get('/callback', handleSpotifyCallback);

// YouTube search routes
app.use('/youtube', youtubeRouter);

// Thumbnail proxy to keep image loads same-origin inside Discord Activity iframe.
app.get('/media/thumb', async (req, res) => {
  const src = String(req.query.src || '');
  if (!src) return res.status(400).send('Missing src');

  let parsed;
  try {
    parsed = new URL(src);
  } catch {
    return res.status(400).send('Invalid src');
  }

  const host = parsed.hostname.toLowerCase();
  const allowedHosts = [
    'i.ytimg.com',
    'yt3.ggpht.com',
    'lh3.googleusercontent.com',
    'i.scdn.co',
    'mosaic.scdn.co',
  ];
  if (!allowedHosts.includes(host)) {
    return res.status(403).send('Host not allowed');
  }

  try {
    const response = await axios.get(parsed.toString(), {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: { 'User-Agent': 'DiscordMusicActivity/1.0' },
    });

    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (response.headers['content-type']) {
      res.setHeader('Content-Type', response.headers['content-type']);
    } else {
      res.setHeader('Content-Type', 'image/jpeg');
    }
    res.send(Buffer.from(response.data));
  } catch (err) {
    console.error('Thumbnail proxy error:', err.response?.status || err.message);
    res.status(502).send('Thumbnail fetch failed');
  }
});

// Discord OAuth token exchange — required by the Embedded App SDK
app.post('/discord/token', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  try {
    const response = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json({ access_token: response.data.access_token });
  } catch (err) {
    console.error('Discord token exchange failed:', err.response?.data);
    res.status(500).json({ error: 'Discord auth failed' });
  }
});

// ────────────────────────────────────────────────
// Room state  (channelId → room object)
// ────────────────────────────────────────────────
const rooms = new Map();

// Pending DJ-claim requests  (channelId → { claimerId, claimerUsername, timer, claimerSocketId })
const pendingClaims = new Map();

function getRoom(channelId) {
  if (!rooms.has(channelId)) {
    rooms.set(channelId, {
      queue: [],
      currentIndex: -1,
      isPlaying: false,
      djUserId: null,
      currentService: 'youtube',
      position: 0,
      syncedAt: Date.now(),
    });
  }
  return rooms.get(channelId);
}

// ────────────────────────────────────────────────
// Socket.io — real-time sync
// ────────────────────────────────────────────────
io.on('connection', (socket) => {
  const { channelId, userId, username } = socket.handshake.query;

  if (!channelId || !userId) {
    socket.disconnect(true);
    return;
  }

  socket.join(channelId);
  const room = getRoom(channelId);

  // First user becomes DJ; if the previous DJ reconnects, restore their role
  if (!room.djUserId || room.djUserId === userId) {
    room.djUserId = userId;
  }

  socket.emit('room:state', { ...room });
  socket.to(channelId).emit('user:joined', { userId, username });

  // Anyone can add a track
  socket.on('queue:add', (track) => {
    if (!track?.id || !track?.title || !track?.service) return;
    room.queue.push({
      id: track.id,
      title: track.title,
      artist: track.artist || '',
      thumbnail: track.thumbnail || '',
      service: track.service,
      addedBy: username,
    });
    if (room.currentIndex === -1) {
      room.currentIndex = 0;
      room.isPlaying = true;
      room.position = 0;
      room.syncedAt = Date.now();
    }
    io.to(channelId).emit('room:state', { ...room });
  });

  // Only the DJ can skip
  socket.on('queue:skip', () => {
    if (userId !== room.djUserId) return;
    if (room.currentIndex < room.queue.length - 1) {
      room.currentIndex++;
      room.position = 0;
      room.syncedAt = Date.now();
      room.isPlaying = true;
    } else {
      room.isPlaying = false;
    }
    io.to(channelId).emit('room:state', { ...room });
  });

  // DJ pushes periodic position/state sync to followers
  socket.on('player:sync', ({ position, isPlaying }) => {
    if (userId !== room.djUserId) return;
    if (typeof position === 'number') room.position = position;
    if (typeof isPlaying === 'boolean') room.isPlaying = isPlaying;
    room.syncedAt = Date.now();
    socket.to(channelId).emit('room:state', { ...room });
  });

  // Only the DJ can switch services
  socket.on('service:switch', (service) => {
    if (userId !== room.djUserId) return;
    if (service !== 'youtube' && service !== 'spotify') return;
    room.currentService = service;
    io.to(channelId).emit('room:state', { ...room });
  });

  // Anyone can remove a track
  socket.on('queue:remove', (index) => {
    if (typeof index !== 'number' || index < 0 || index >= room.queue.length) return;
    room.queue.splice(index, 1);
    if (room.queue.length === 0) {
      room.currentIndex = -1;
      room.isPlaying = false;
    } else if (index === room.currentIndex) {
      room.currentIndex = Math.min(room.currentIndex, room.queue.length - 1);
      room.position = 0;
      room.syncedAt = Date.now();
    } else if (index < room.currentIndex) {
      room.currentIndex = Math.max(0, room.currentIndex - 1);
    }
    io.to(channelId).emit('room:state', { ...room });
  });

  // DJ jumps to a specific track
  socket.on('queue:play-now', (index) => {
    if (userId !== room.djUserId) return;
    if (typeof index !== 'number' || index < 0 || index >= room.queue.length) return;
    room.currentIndex = index;
    room.position = 0;
    room.syncedAt = Date.now();
    room.isPlaying = true;
    io.to(channelId).emit('room:state', { ...room });
  });

  // Any user can claim DJ:
  //   • If the DJ is offline → immediately transfer
  //   • If the DJ is online  → notify them and start a 10 s auto-transfer timer
  socket.on('dj:claim', () => {
    const activeSockets = io.sockets.adapter.rooms.get(channelId);

    const djSocket = activeSockets
      ? [...activeSockets]
          .map((sid) => io.sockets.sockets.get(sid))
          .find((s) => s && s.handshake.query.userId === room.djUserId && s.id !== socket.id)
      : undefined;

    if (!djSocket) {
      // DJ is offline — transfer immediately
      room.djUserId = userId;
      io.to(channelId).emit('dj:changed', { djUserId: room.djUserId });
      return;
    }

    // Cancel any previous pending claim from another user
    const existing = pendingClaims.get(channelId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      pendingClaims.delete(channelId);
      room.djUserId = userId;
      io.to(channelId).emit('dj:changed', { djUserId: room.djUserId });
    }, 10000);

    pendingClaims.set(channelId, {
      claimerId: userId,
      claimerUsername: username,
      timer,
      claimerSocketId: socket.id,
    });

    djSocket.emit('dj:claim-request', { claimerId: userId, claimerUsername: username });
  });

  // Current DJ responds to a pending claim request
  socket.on('dj:claim-respond', ({ approved }) => {
    if (userId !== room.djUserId) return;
    const pending = pendingClaims.get(channelId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingClaims.delete(channelId);

    if (approved) {
      room.djUserId = pending.claimerId;
      io.to(channelId).emit('dj:changed', { djUserId: room.djUserId });
    } else {
      const claimerSocket = io.sockets.sockets.get(pending.claimerSocketId);
      claimerSocket?.emit('dj:claim-denied');
    }
  });

  // Claimer cancels their pending request
  socket.on('dj:claim-cancel', () => {
    const pending = pendingClaims.get(channelId);
    if (!pending || pending.claimerId !== userId) return;
    clearTimeout(pending.timer);
    pendingClaims.delete(channelId);
    // Notify the DJ that the request was cancelled
    const activeSockets = io.sockets.adapter.rooms.get(channelId);
    const djSocket = activeSockets
      ? [...activeSockets]
          .map((sid) => io.sockets.sockets.get(sid))
          .find((s) => s && s.handshake.query.userId === room.djUserId)
      : undefined;
    djSocket?.emit('dj:claim-cancelled');
  });

  // Drag-and-drop reorder
  socket.on('queue:reorder', ({ from, to }) => {
    if (typeof from !== 'number' || typeof to !== 'number') return;
    if (from < 0 || from >= room.queue.length || to < 0 || to >= room.queue.length) return;
    if (from === to) return;
    const [moved] = room.queue.splice(from, 1);
    room.queue.splice(to, 0, moved);
    if (room.currentIndex === from) {
      room.currentIndex = to;
    } else if (from < room.currentIndex && to >= room.currentIndex) {
      room.currentIndex -= 1;
    } else if (from > room.currentIndex && to <= room.currentIndex) {
      room.currentIndex += 1;
    }
    io.to(channelId).emit('room:state', { ...room });
  });

  socket.on('disconnect', () => {
    socket.to(channelId).emit('user:left', { userId });

    if (room.djUserId === userId) {
      const sockets = io.sockets.adapter.rooms.get(channelId);
      if (sockets?.size > 0) {
        const nextSocketId = [...sockets][0];
        const nextSocket = io.sockets.sockets.get(nextSocketId);
        if (nextSocket) {
          room.djUserId = nextSocket.handshake.query.userId;
          io.to(channelId).emit('dj:changed', { djUserId: room.djUserId });
        }
      }
      // If room is empty, keep djUserId so the same person reclaims it on rejoin
    }
  });
});

// Serve React production build (client/dist) for Discord Activity
const clientDist = join(__dirname, '../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(join(clientDist, 'index.html'));
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
