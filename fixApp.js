const fs = require('fs');
const p = 'C:/Users/romok/Documents/GitHub/DiscordMusicActivity/client/src/App.jsx';
let c = fs.readFileSync(p, 'utf8');

const inject1 = \  const [claimPending, setClaimPending] = useState(null); // { claimerUsername, countdown }
  const [spotifyLoginUrl, setSpotifyLoginUrl] = useState('');\;
c = c.replace(/  const \\\[claimPending, setClaimPending\\] = useState\\(null\\); .*?/, inject1);

const effectsBlock = \
  useEffect(() => {
    if (ready && user && socketRef.current?.id) {
      const serverOrigin = new URL(import.meta.env.VITE_SERVER_URL || window.location.origin).origin;
      const clientOrigin = window.location.origin;
      const socketId = socketRef.current.id;
      const fetchUrl = \\\\\\/api/spotify/login-url?userId=\\\&socketId=\\\&origin=\\\&client_origin=\\\\\\;
      
      fetch(fetchUrl)
        .then((res) => res.json())
        .then((data) => setSpotifyLoginUrl(data.url))
        .catch((err) => console.error('Failed to prefetch Spotify URL:', err));
    }
  }, [ready, user]);
\;
c = c.replace(/  const socketRef = useRef\\(null\\);/, "  const socketRef = useRef(null);" + "\\n" + effectsBlock);

const propRegex = /onSpotifyLogin=\\{async \\(\\) => \\{[\\s\\S]*?\\}\\}\\s*onSpotifyLogout=/m;
const newProp = \onSpotifyLogin={() => {
              if (!spotifyLoginUrl) return;
              if (discordSdk) {
                discordSdk.commands.openExternalLink({ url: spotifyLoginUrl }).catch(err => console.error('Failed to open external link:', err));
              } else {
                window.open(spotifyLoginUrl, '_blank');
              }
            }}
            onSpotifyLogout=\;

if (propRegex.test(c)) {
  c = c.replace(propRegex, newProp);
  fs.writeFileSync(p, c);
  console.log('App.jsx patched successfully.');
} else {
  console.log('Failed to find onSpotifyLogin prop.');
}
