
const fs = require('fs');
const p = 'C:/Users/romok/Documents/GitHub/DiscordMusicActivity/client/src/App.jsx';
let c = fs.readFileSync(p, 'utf8');

const startIndex = c.indexOf('onSpotifyLogin={async () => {');
const endIndex = c.indexOf('onSpotifyLogout={() => {', startIndex);

if (startIndex !== -1 && endIndex !== -1) {
  const repl = \onSpotifyLogin={async () => {
              const serverOrigin = new URL(import.meta.env.VITE_SERVER_URL || window.location.origin).origin;
              const clientOrigin = window.location.origin;
              const socketId = socketRef.current?.id || '';
              try {
                const fetchUrl = \\\\\\/api/spotify/login-url?userId=\\\&socketId=\\\&origin=\\\&client_origin=\\\\\\;
                const res = await fetch(fetchUrl);
                const data = await res.json();
                if (discordSdk) {
                  await discordSdk.commands.openExternalLink({ url: data.url });
                } else {
                  window.open(data.url, '_blank');
                }
              } catch (err) {
                console.error('Failed to launch Spotify login:', err);
              }
            }}
            \;
  c = c.substring(0, startIndex) + repl + c.substring(endIndex);
  fs.writeFileSync(p, c);
} else { console.log('not found'); }

