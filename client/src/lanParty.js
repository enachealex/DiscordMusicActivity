// LAN Party mode: this site running as a hosted app inside a LAN Party voice channel.
//
// LAN Party frames the site on its own origin with ?lanparty=1 and talks to it over
// postMessage (the bridge in vendor/lanparty.js). The bridge says who is looking and
// gives an opaque id for the voice channel, which is all this app needs to put
// everyone in the channel into the same queue under their LAN Party name.
//
// The trust decision is the origin allowlist below, fixed when the client is built.
// Any page can frame this site and add ?lanparty=1; only a page on a listed origin can
// complete the handshake, because the browser itself delivers and labels the messages.
// So the host origin is never read from the URL or from a message — a framing page
// would simply name itself.

const DEFAULT_HOST_ORIGINS = 'https://lanparty.thejumpvault.com';
// LAN Party's own dev server. Dev builds only, so a production bundle never accepts
// whatever happens to be listening on someone's localhost.
const DEV_HOST_ORIGIN = 'http://localhost:3000';
const HANDSHAKE_TIMEOUT_MS = 3000;
// Headroom on top of the handshake for fetching the bridge chunk itself, so a stalled
// download ends in the ordinary website rather than a permanent spinner.
const LOAD_ALLOWANCE_MS = 2000;
// What LAN Party promises for a room id: 32 lowercase hex characters. Checked here
// because it becomes part of a room key the server also holds to this exact shape.
const ROOM_ID_PATTERN = /^[0-9a-f]{32}$/;
// LAN Party caps names at 80 characters; this only stops a misbehaving host from
// putting something enormous into the socket handshake.
const MAX_NAME_LENGTH = 80;

// Both conditions are cheap and known synchronously, which matters: App.jsx has to
// decide whether to construct the Discord SDK before anything async can run.
export const isLanPartyCandidate = (() => {
  try {
    return window.parent !== window
      && new URLSearchParams(window.location.search).get('lanparty') === '1';
  } catch {
    return false;
  }
})();

function allowedHostOrigins() {
  const configured = import.meta.env.VITE_LANPARTY_ORIGINS || DEFAULT_HOST_ORIGINS;
  const origins = configured.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (import.meta.env.DEV) origins.push(DEV_HOST_ORIGIN);
  return origins;
}

async function handshake() {
  // Loaded on demand: the website, the Discord activity and the Android app never
  // fetch or run the bridge at all.
  await import('./vendor/lanparty.js');
  // The bridge drops entries that are not origins and, given a list with nothing
  // usable in it, accepts no host at all rather than falling back to "anyone".
  const hostOrigins = allowedHostOrigins();
  const lp = await window.LANParty.connect({ hostOrigins, timeoutMs: HANDSHAKE_TIMEOUT_MS });
  if (lp.standalone) {
    // Said out loud because the symptom is otherwise silent: the app works, but as a
    // private web session instead of the channel's. The usual cause is a LAN Party
    // served from an origin this build was not told about (VITE_LANPARTY_ORIGINS).
    console.warn(`LAN Party did not answer from an allowed origin (${hostOrigins.join(', ')}); continuing as the website.`);
    return null;
  }

  const me = lp.me;
  const username = String(me.username || '').slice(0, MAX_NAME_LENGTH);
  if (!username) return null;
  const displayName = String(me.displayName || '').slice(0, MAX_NAME_LENGTH) || username;

  // No room (the app was opened on its own in LAN Party's viewer) or an id that is
  // not the promised shape both mean "no shared room": the caller uses a private one.
  const roomId = lp.room?.id;
  return {
    username,
    displayName,
    roomId: typeof roomId === 'string' && ROOM_ID_PATTERN.test(roomId) ? roomId : null,
  };
}

let attempt = null;

// Resolves to { username, displayName, roomId } when a listed LAN Party host answered,
// or null for everything else — not framed that way, no answer in time, an unlisted
// host, a failed chunk load. It never rejects: null means "behave as the ordinary
// website". One attempt per page load, shared by every caller (React StrictMode runs
// the init effect twice in development).
export function connectLanParty() {
  if (!isLanPartyCandidate) return Promise.resolve(null);
  if (!attempt) {
    const giveUp = new Promise((resolve) => {
      setTimeout(() => resolve(null), HANDSHAKE_TIMEOUT_MS + LOAD_ALLOWANCE_MS);
    });
    attempt = Promise.race([handshake(), giveUp])
      .catch((err) => {
        console.warn('LAN Party bridge unavailable:', err?.message || err);
        return null;
      })
      .then((session) => {
        // The layout keys off this class (index.css, "LAN Party mode"): inside LAN Party
        // the app fills whatever frame it is given instead of sitting in the middle of
        // it as the fixed-size Discord panel. Set only once the handshake has succeeded,
        // like everything else LAN Party mode changes, and before App renders anything
        // past its loading screen, so the layout never jumps.
        if (session) document.documentElement.classList.add('lanparty');
        return session;
      });
  }
  return attempt;
}
