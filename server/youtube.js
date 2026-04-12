import express from 'express';
import axios from 'axios';
import ytdl from '@distube/ytdl-core';
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
      title: item.snippet.title,
      artist: item.snippet.channelTitle,
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

  try {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const info = await ytdl.getInfo(url);
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highestaudio',
      filter: 'audioonly',
    });

    const total = Number(format.contentLength || 0);
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = total > 0 ? total - 1 : undefined;

    if (rangeHeader && total > 0) {
      const match = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader);
      if (match) {
        start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
      }
      if (start >= total) {
        return res.status(416).set('Content-Range', `bytes */${total}`).end();
      }
      if (end === undefined || end >= total) end = total - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
    } else if (total > 0) {
      res.setHeader('Content-Length', String(total));
    }

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', format.mimeType?.split(';')[0] || 'audio/webm');
    res.setHeader('Cache-Control', 'no-store');

    const stream = ytdl.downloadFromInfo(info, {
      quality: format.itag,
      range: end !== undefined ? { start, end } : start > 0 ? { start } : undefined,
      requestOptions: {
        headers: {
          'User-Agent': 'DiscordMusicActivity/1.0',
        },
      },
      highWaterMark: 1 << 24,
    });

    stream.on('error', (err) => {
      console.error('YouTube audio stream error:', err.message);
      if (!res.headersSent) res.status(502).end('Audio stream failed');
    });
    stream.pipe(res);
  } catch (err) {
    console.error('YouTube audio route error:', err.message);
    res.status(500).json({ error: 'YouTube audio failed' });
  }
});
