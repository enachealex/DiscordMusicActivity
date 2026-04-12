const fs = require('fs');
let c = fs.readFileSync('C:/Users/romok/Documents/GitHub/DiscordMusicActivity/server/spotify.js', 'utf8');
const searchBlock = \
// Proxy search so the API key is never exposed to the client
spotifyRouter.get('/search', async (req, res) => {
  const { q, access_token } = req.query;
  if (!q || !access_token) return res.status(400).json({ error: 'q and access_token required' });

  try {
    const { data } = await axios.get('https://api.spotify.com/v1/search', {
      params: { q, type: 'track', limit: 10 },
      headers: { Authorization: \\\Bearer \\\\\\ },
    });
    const tracks = data.tracks.items.map((track) => ({
      id: track.uri,
      title: track.name,
      artist: track.artists.map((a) => a.name).join(', '),
      thumbnail: proxiedThumb(track.album.images[1]?.url || track.album.images[0]?.url),\;

const start = c.indexOf("  // Return the Spotify login URL");
const end = c.indexOf("      duration: track.duration_ms,");

if (start !== -1 && end !== -1) {
  const keep = c.substring(start, c.indexOf("    res.json({ url: \\\https://accounts.spotify.com/authorize?\\\\\\ });\n  });") + 82);
  c = c.substring(0, start) + keep + "\n\n" + searchBlock + "\n      " + c.substring(end);
  fs.writeFileSync('C:/Users/romok/Documents/GitHub/DiscordMusicActivity/server/spotify.js', c);
  console.log("Fixed!");
} else {
  console.log("Could not find boundaries", start, end);
}
