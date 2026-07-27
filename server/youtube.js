import express from 'express';
import axios from 'axios';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

export const youtubeRouter = express.Router();

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const AUDIO_URL_TTL_MS = 55 * 60 * 1000; // YouTube signed URLs last ~6h; 55 min gives safe re-use window
const audioUrlCache = new Map();
const inflightAudioUrlResolves = new Map();

// ── yt-dlp concurrency limiter ──────────────────────────────────────────────
// Prevents hammering YouTube / the server when many tracks are warmed at once.
const MAX_CONCURRENT_YTDLP = 4;
let activeYtdlpCount = 0;
const ytdlpWaitQueue = [];

function acquireYtdlpSlot() {
  return new Promise((resolve) => {
    if (activeYtdlpCount < MAX_CONCURRENT_YTDLP) {
      activeYtdlpCount++;
      resolve();
    } else {
      ytdlpWaitQueue.push(resolve);
    }
  });
}

function releaseYtdlpSlot() {
  const next = ytdlpWaitQueue.shift();
  if (next) {
    next(); // slot transferred — count stays the same
  } else {
    activeYtdlpCount--;
  }
}

function proxiedThumb(url) {
  if (!url) return '';
  return `/media/thumb?src=${encodeURIComponent(url)}`;
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function getCachedAudioUrl(videoId) {
  const cached = audioUrlCache.get(videoId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    audioUrlCache.delete(videoId);
    return null;
  }
  return cached.audioUrl;
}

function pruneAudioUrlCache(maxEntries = 500) {
  if (audioUrlCache.size <= maxEntries) return;
  for (const [key, value] of audioUrlCache.entries()) {
    if (value.expiresAt <= Date.now()) {
      audioUrlCache.delete(key);
    }
  }
}

async function resolveAudioUrl(videoId) {
  const cachedAudioUrl = getCachedAudioUrl(videoId);
  if (cachedAudioUrl) {
    return { audioUrl: cachedAudioUrl, fromCache: true };
  }

  const existingResolve = inflightAudioUrlResolves.get(videoId);
  if (existingResolve) {
    return existingResolve;
  }

  const resolvePromise = (async () => {
    await acquireYtdlpSlot();
    try {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const ytdlp = spawn('yt-dlp', [
        // Prefer the highest-bitrate audio-only stream. Opus (webm) and m4a both play
        // in browsers and the Discord Activity webview; -S sorts candidates so the
        // best audio bitrate (abr) wins instead of defaulting to a compatibility format.
        '-f', 'bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio',
        '-S', 'acodec:opus,abr,asr',
        '--no-playlist',
        '--no-warnings',
        '-g',
        url,
      ]);

      let audioUrl = '';
      let stderr = '';

      ytdlp.stdout.on('data', (chunk) => { audioUrl += chunk.toString(); });
      ytdlp.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      const exitCode = await new Promise((resolve, reject) => {
        ytdlp.once('error', reject);
        ytdlp.once('close', resolve);
      });

      audioUrl = audioUrl.trim();
      if (exitCode !== 0 || !audioUrl) {
        const err = new Error('Failed to get audio URL');
        err.details = stderr;
        throw err;
      }

      audioUrlCache.set(videoId, {
        audioUrl,
        expiresAt: Date.now() + AUDIO_URL_TTL_MS,
      });
      pruneAudioUrlCache();

      return { audioUrl, fromCache: false };
    } finally {
      releaseYtdlpSlot();
    }
  })().finally(() => {
    inflightAudioUrlResolves.delete(videoId);
  });

  inflightAudioUrlResolves.set(videoId, resolvePromise);
  return resolvePromise;
}

export function warmYoutubeQueueAhead(queue, currentIndex, count = 4) {
  if (!Array.isArray(queue) || queue.length === 0) return;
  const startIndex = Math.max(0, Number(currentIndex ?? -1) + 1);
  const ids = queue
    .slice(startIndex, startIndex + count)
    .filter((track) => track?.service === 'youtube' && track?.id)
    .map((track) => track.id);

  for (const videoId of ids) {
    resolveAudioUrl(videoId).catch(() => {
      // Best-effort warmup only; regular playback path still handles failures.
    });
  }
}

// Pull a video id out of any common YouTube URL form. Returns null for non-URLs
// (plain keyword searches) so callers fall through to the normal search path.
//   https://www.youtube.com/watch?v=ID   /  &v=ID
//   https://youtu.be/ID
//   https://www.youtube.com/shorts/ID  /  /embed/ID  /  /live/ID
//   https://music.youtube.com/watch?v=ID
function extractYouTubeVideoId(input) {
  const text = String(input || '').trim();
  if (!/youtu\.?be/i.test(text)) return null;
  let url;
  try {
    url = new URL(text.startsWith('http') ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    id = url.searchParams.get('v');
    if (!id) {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
      if (m) id = m[1];
    }
  }
  return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
}

// Look up a single video by id via the YouTube Data API and shape it like a
// search result. Used when the user pastes a YouTube URL into the search bar.
async function lookupYouTubeVideo(videoId) {
  const { data } = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
    params: { part: 'snippet', id: videoId, key: YOUTUBE_API_KEY },
  });
  const item = data.items?.[0];
  if (!item) return null;
  return {
    id: videoId,
    title: decodeHtmlEntities(item.snippet.title),
    artist: decodeHtmlEntities(item.snippet.channelTitle),
    thumbnail: proxiedThumb(
      item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url
    ),
    service: 'youtube',
  };
}

youtubeRouter.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query required' });

  // If the query is a YouTube URL, resolve that exact video instead of searching.
  const pastedVideoId = extractYouTubeVideoId(q);
  if (pastedVideoId) {
    try {
      const video = await lookupYouTubeVideo(pastedVideoId);
      return res.json(video ? [video] : []);
    } catch (err) {
      console.error('YouTube video lookup error:', err.response?.data || err.message);
      return res.status(500).json({ error: 'YouTube lookup failed' });
    }
  }

  try {
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: String(q),
        type: 'video',
        videoCategoryId: '10', // Music
        maxResults: 25,
        key: YOUTUBE_API_KEY,
      },
    });

    const results = data.items.map((item) => ({
      id: item.id.videoId,
      title: decodeHtmlEntities(item.snippet.title),
      artist: decodeHtmlEntities(item.snippet.channelTitle),
      thumbnail: proxiedThumb(
        item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url
      ),
      service: 'youtube',
    }));

    res.json(results);
  } catch (err) {
    console.error('YouTube search error:', err.response?.data);
    res.status(500).json({ error: 'YouTube search failed' });
  }
});

youtubeRouter.get('/audio/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(String(videoId || ''))) {
    return res.status(400).json({ error: 'Invalid video id' });
  }

  // ?fresh=1 forces a new yt-dlp run (used by the client after a playback error).
  if (req.query.fresh === '1') {
    audioUrlCache.delete(videoId);
  }

  try {
    const { audioUrl } = await resolveAudioUrl(videoId);

    // Proxy the audio stream from YouTube to the client
    const headers = {};
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const response = await axios.get(audioUrl, {
      responseType: 'stream',
      headers,
      // Long tracks can exceed 30s; disable axios timeout for streaming.
      timeout: 0,
    });

    // Forward status and relevant headers
    res.status(response.status);
    const forward = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    for (const h of forward) {
      if (response.headers[h]) res.setHeader(h, response.headers[h]);
    }
    // Allow browsers to cache the audio response so prefetched tracks are served
    // instantly from the browser cache on the next request to the same URL.
    res.setHeader('Cache-Control', 'private, max-age=3600');

    response.data.on('error', (err) => {
      if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.message === 'aborted') return;
      console.error('YouTube audio stream error:', err.message);
      if (!res.headersSent) res.status(502).end('Audio stream failed');
    });

    // Stop pulling from upstream when the client disconnects.
    req.on('close', () => {
      if (!response.data.destroyed) {
        response.data.destroy();
      }
    });

    response.data.pipe(res);
  } catch (err) {
    // Evict the cached URL if YouTube rejected it — forces a fresh yt-dlp run next request.
    if (err?.response?.status === 403 || err?.response?.status === 410) {
      audioUrlCache.delete(videoId);
    }
    if (err?.code === 'ENOENT') {
      console.error('yt-dlp not found:', err.message);
      return res.status(502).json({ error: 'Audio extraction tool not available' });
    }
    if (err?.details) {
      console.error('yt-dlp error:', err.details);
      return res.status(502).json({ error: 'Failed to get audio URL' });
    }
    console.error('YouTube audio route error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'YouTube audio failed' });
  }
});

youtubeRouter.get('/resolve/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(String(videoId || ''))) {
    return res.status(400).json({ error: 'Invalid video id' });
  }

  try {
    const result = await resolveAudioUrl(videoId);
    res.json({ ok: true, fromCache: result.fromCache });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      console.error('yt-dlp not found:', err.message);
      return res.status(502).json({ error: 'Audio extraction tool not available' });
    }
    if (err?.details) {
      console.error('yt-dlp resolve error:', err.details);
      return res.status(502).json({ error: 'Failed to resolve audio URL' });
    }
    console.error('YouTube resolve route error:', err.message);
    res.status(500).json({ error: 'YouTube resolve failed' });
  }
});
