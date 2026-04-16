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

youtubeRouter.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query required' });

  try {
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: String(q),
        type: 'video',
        videoCategoryId: '10', // Music
        maxResults: 10,
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

    console.log('[YT search] first title:', results[0]?.title);
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

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    // Use yt-dlp to get the best audio URL
    let ytdlp;
    try {
      ytdlp = spawn('yt-dlp', [
        '-f', 'bestaudio[ext=webm]/bestaudio',
        '--no-playlist',
        '--no-warnings',
        '-g',  // print URL only
        url,
      ]);
    } catch (spawnError) {
      console.error('yt-dlp not found:', spawnError.message);
      return res.status(502).json({ error: 'Audio extraction tool not available' });
    }

    let audioUrl = '';
    let stderr = '';

    ytdlp.stdout.on('data', (chunk) => { audioUrl += chunk.toString(); });
    ytdlp.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const exitCode = await new Promise((resolve) => ytdlp.on('close', resolve));

    audioUrl = audioUrl.trim();
    if (exitCode !== 0 || !audioUrl) {
      console.error('yt-dlp error:', stderr);
      return res.status(502).json({ error: 'Failed to get audio URL' });
    }

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
    res.setHeader('Cache-Control', 'no-store');

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
    console.error('YouTube audio route error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'YouTube audio failed' });
  }
});
