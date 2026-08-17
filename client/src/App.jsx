import { useState, useEffect, useRef, useMemo } from 'react';
import { DiscordSDK, patchUrlMappings } from '@discord/embedded-app-sdk';
import { io } from 'socket.io-client';
import ServiceSelector from './components/ServiceSelector.jsx';
import YouTubePlayer from './components/YouTubePlayer.jsx';
import SpotifyPlayer from './components/SpotifyPlayer.jsx';
import Queue from './components/Queue.jsx';
import Search from './components/Search.jsx';
import DJBadge from './components/DJBadge.jsx';
import PlayerControls from './components/PlayerControls.jsx';
import ListenTogether from './components/ListenTogether.jsx';
import EqSelector from './components/EqSelector.jsx';
import DiscordParty from './components/DiscordParty.jsx';
import InstallAppBanner from './components/InstallAppBanner.jsx';
import QueueMemory from './components/QueueMemory.jsx';
import { useMediaSession } from './useMediaSession.js';
import BackgroundPlaybackPrompt from './components/BackgroundPlaybackPrompt.jsx';
import { isNativeApp, readBackgroundPreference, writeBackgroundPreference } from './backgroundPlayback.js';
import {
  isRememberQueueEnabled,
  setRememberQueue,
  loadRememberedQueue,
  saveRememberedQueue,
  clearRememberedQueue,
} from './queueMemory.js';

const DISCORD_CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID || '1492382387139772476';

// Slider position -> actual gain. Squared, so halfway down the slider is a quarter
// of the amplitude rather than half — much closer to how loudness is heard, and it
// makes the bottom of the range genuinely quiet instead of merely small.
const VOLUME_CURVE = 2;
// Chosen so the default still *sounds* like the previous linear 0.7.
const DEFAULT_VOLUME_POSITION = 0.84;

function gainFromPosition(position) {
  const clamped = Math.max(0, Math.min(1, Number(position) || 0));
  return clamped ** VOLUME_CURVE;
}

let discordSdk = null;
try {
  discordSdk = new DiscordSDK(DISCORD_CLIENT_ID);
} catch (e) {
  console.warn('Discord SDK unavailable:', e.message);
}

// True when running on the plain website rather than embedded in Discord.
const isWebMode = !discordSdk;

// Parse a "Listen Together" room code from the URL: /room/CODE or ?room=CODE.
// Returns the uppercased code, or null for a normal (solo) web visit.
function getRoomCodeFromUrl() {
  const m = window.location.pathname.match(/^\/room\/([A-Z0-9]{4,8})$/i);
  if (m) return m[1].toUpperCase();
  const q = new URLSearchParams(window.location.search).get('room');
  return q ? q.toUpperCase() : null;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);
  const [room, setRoom] = useState(null);
  const [detached, setDetached] = useState(false);
  const [detachedService, setDetachedService] = useState(null);
  const [detachedRoom, setDetachedRoom] = useState(null);
  // Web-only audio EQ preset (flat | bass | treble | vocal). Persisted per browser.
  const [eqMode, setEqMode] = useState(() => localStorage.getItem('eq-mode') || 'flat');
  // Listen Together: the room code this web session is part of (null = solo / Discord).
  const [roomCode, setRoomCode] = useState(() => (isWebMode ? getRoomCodeFromUrl() : null));
  // The resolved "home" room key for this session (web solo: / Discord discord:<channel>).
  const [defaultChannelId, setDefaultChannelId] = useState(null);
  // Discord-only: a Listen Together party code this user has joined in-place (null = none).
  // Any Discord user (solo, voice channel, or group) can join/leave a party by code.
  const [discordPartyCode, setDiscordPartyCode] = useState(null);
  const [showDebug, setShowDebug] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [spotifyToken, setSpotifyToken] = useState(null);
  const [spotifyRestoring, setSpotifyRestoring] = useState(
    () => !!localStorage.getItem('spotify_refresh_token')
  );
  const [localPlaying, setLocalPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [loop, setLoop] = useState('off'); // 'off' | 'track' | 'queue'
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  // The slider holds a *position*, not a gain. Loudness is perceived roughly
  // logarithmically, so a linear slider puts almost the entire usable quiet range
  // in its bottom few percent — which is why "I can't get it quiet enough" is a
  // real complaint even though 2% was always reachable. Squaring the position
  // spreads the quiet end across most of the travel.
  const [volume, setVolume] = useState(() => {
    const saved = parseFloat(localStorage.getItem('volume-position'));
    return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : DEFAULT_VOLUME_POSITION;
  });
  // Loudness smoothing (the compressor + makeup gain in the audio graph). On by
  // default, which is how it has always behaved; the control just makes it visible.
  const [balance, setBalance] = useState(() => localStorage.getItem('balance-mode') !== 'off');
  // Packaged-app only: hold an OS media session (notification + lock screen controls,
  // foreground service) while playing. Null until the listener has been asked.
  const [backgroundPlayback, setBackgroundPlayback] = useState(() => readBackgroundPreference());
  const [showBackgroundPrompt, setShowBackgroundPrompt] = useState(false);
  const [debugInfo, setDebugInfo] = useState({
    service: '-',
    playerState: '-',
    autoplayBlocked: false,
    spotifySdkReady: false,
    spotifyDeviceId: '-',
    spotifyLastPlayStatus: '-',
    lastEvent: 'boot',
    updatedAt: Date.now(),
  });
  // DJ-claim request state
  const [claimRequest, setClaimRequest] = useState(null); // { claimerId, claimerUsername, countdown }
  const [claimPending, setClaimPending] = useState(null); // { claimerUsername, countdown } 
  const [isMobileLayout, setIsMobileLayout] = useState(() => window.innerWidth <= 600);
  // Web solo sessions can keep their queue in this browser between visits.
  const [rememberQueue, setRememberQueueState] = useState(() => isWebMode && isRememberQueueEnabled());
  const socketRef = useRef(null);
  const preloadedYoutubeIdsRef = useRef(new Set());
  // Whether this session has ever held tracks — distinguishes "empty because we just
  // connected" from "empty because the listener cleared it".
  const sawTracksRef = useRef(false);
  // Tracks already played in the current shuffle pass. Shuffle used to pick a fresh
  // random index every time, which repeats songs and can starve others entirely; a
  // pass plays each song once and only then ends (or reshuffles, if looping).
  const shufflePassRef = useRef(new Set());
  const resolvedServerUrl = useMemo(() => {
    const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isLocalHost) return window.location.origin;
    return import.meta.env.VITE_SERVER_URL || window.location.origin;
  }, []);
  const spotifyLoginUrl = useMemo(() => {
    if (!ready || !user) return '';
    const serverOrigin = new URL(resolvedServerUrl).origin;
    const clientOrigin = window.location.origin;
    const effectiveSocketId = socketId || socketRef.current?.id || '';
    return `${serverOrigin}/spotify/login?userId=${encodeURIComponent(user.id || '')}&socketId=${encodeURIComponent(effectiveSocketId)}&origin=${encodeURIComponent(serverOrigin)}&client_origin=${encodeURIComponent(clientOrigin)}`;
  }, [ready, user, socketId, resolvedServerUrl]);

  const playerActionsRef = useRef({ toggle: () => {}, getPosition: () => 0, getDuration: () => 0, setVolume: () => {}, seek: () => {} });

  // Identity for the shuffle pass. Ids stay stable when the queue is reordered or
  // trimmed, which indices do not.
  function trackKey(track) {
    return track?.id ? `${track.service || 'youtube'}:${track.id}` : null;
  }

  // Indices still owed a turn this pass, excluding whatever is playing now.
  function unplayedIndices(queue, currentIndex) {
    const out = [];
    for (let i = 0; i < queue.length; i++) {
      if (i === currentIndex) continue;
      const key = trackKey(queue[i]);
      if (key && shufflePassRef.current.has(key)) continue;
      out.push(i);
    }
    return out;
  }

  function pickRandom(indices) {
    return indices[Math.floor(Math.random() * indices.length)];
  }

  // Begin a fresh pass. The track playing right now counts as already played, so it
  // isn't handed out again later in the same pass.
  function resetShufflePass(seedTrack) {
    shufflePassRef.current = new Set();
    const key = trackKey(seedTrack);
    if (key) shufflePassRef.current.add(key);
  }

  function cloneRoomState(baseRoom) {
    if (!baseRoom) {
      return {
        queue: [],
        deletedHistory: [],
        currentIndex: -1,
        isPlaying: false,
        currentService: 'youtube',
        position: 0,
        syncedAt: Date.now(),
      };
    }

    return {
      queue: [...(baseRoom.queue || [])],
      deletedHistory: [...(baseRoom.deletedHistory || [])],
      currentIndex: typeof baseRoom.currentIndex === 'number' ? baseRoom.currentIndex : -1,
      isPlaying: !!baseRoom.isPlaying,
      currentService: baseRoom.currentService || 'youtube',
      position: Number(baseRoom.position || 0),
      syncedAt: Number(baseRoom.syncedAt || Date.now()),
    };
  }

  // Listen for tokens posted from the Spotify OAuth popup
  useEffect(() => {
    function handleMessage(e) {
      const serverOrigin = new URL(resolvedServerUrl).origin;
      if (e.origin !== window.location.origin && e.origin !== serverOrigin) return;
      if (e.data?.type !== 'spotify-auth') return;
      const { access_token, refresh_token, expires_in } = e.data;
      localStorage.setItem('spotify_refresh_token', refresh_token);
      setSpotifyToken({
        access_token,
        refresh_token,
        expires_at: Date.now() + parseInt(expires_in || '3600') * 1000,
      });
      setSpotifyRestoring(false);
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [resolvedServerUrl]);

  // Pick up Spotify tokens after OAuth redirect, or silently restore from localStorage
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const at = params.get('access_token');
    if (at) {
      const rt = params.get('refresh_token');
      const expiresIn = parseInt(params.get('expires_in') || '3600');
      localStorage.setItem('spotify_refresh_token', rt);
      setSpotifyToken({
        access_token: at,
        refresh_token: rt,
        expires_at: Date.now() + expiresIn * 1000,
      });
      setSpotifyRestoring(false);
      // Strip the OAuth query params but keep a /room/CODE path intact so a
      // Listen Together session survives the Spotify login round-trip.
      const cleanPath = getRoomCodeFromUrl() ? window.location.pathname : '/';
      window.history.replaceState({}, '', cleanPath);
    } else {
      // No fresh OAuth — try to silently restore a previous session
      const storedRt = localStorage.getItem('spotify_refresh_token');
      if (storedRt) {
        fetch('/api/spotify/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: storedRt }),
        })
          .then((r) => (r.ok ? r.json() : Promise.reject()))
          .then((data) => {
            const rt = data.refresh_token || storedRt;
            localStorage.setItem('spotify_refresh_token', rt);
            setSpotifyToken({
              access_token: data.access_token,
              refresh_token: rt,
              expires_at: Date.now() + data.expires_in * 1000,
            });
          })
          .catch(() => {
            // Refresh token revoked or network error — clear so user sees connect prompt
            localStorage.removeItem('spotify_refresh_token');
          })
          .finally(() => setSpotifyRestoring(false));
      } else {
        setSpotifyRestoring(false);
      }
    }
  }, []);

  // Spotify token auto-refresh
  useEffect(() => {
    if (!spotifyToken) return;
    const msUntilExpiry = spotifyToken.expires_at - Date.now() - 60_000;
    if (msUntilExpiry <= 0) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/spotify/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: spotifyToken.refresh_token }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const newRt = data.refresh_token || spotifyToken.refresh_token;
        if (data.refresh_token) localStorage.setItem('spotify_refresh_token', data.refresh_token);
        setSpotifyToken((prev) => ({
          ...prev,
          access_token: data.access_token,
          refresh_token: newRt,
          expires_at: Date.now() + data.expires_in * 1000,
        }));
      } catch (err) {
        console.error('Spotify token refresh failed:', err);
      }
    }, msUntilExpiry);
    return () => clearTimeout(timer);
  }, [spotifyToken]);

  // Poll player progress every 500 ms
  useEffect(() => {
    const t = setInterval(() => {
      const pos = playerActionsRef.current.getPosition();
      const dur = playerActionsRef.current.getDuration();
      const safePos = Number.isFinite(pos) ? Math.max(0, pos) : 0;
      const safeDur = Number.isFinite(dur) && dur > 0 ? dur : 0;
      setDuration(safeDur);
      setProgress(safeDur > 0 ? Math.min(safePos, safeDur) : safePos);
    }, 500);
    return () => clearInterval(t);
  }, []);

  // DJ claim request countdown
  useEffect(() => {
    if (!claimRequest) return;
    const timer = setInterval(() => {
      setClaimRequest((prev) => {
        if (!prev) return null;
        if (prev.countdown <= 1) {
          // Time's up — auto-transfer (server will trigger this, but clear the modal here)
          return null;
        }
        return { ...prev, countdown: prev.countdown - 1 };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [claimRequest]);

  // Claimer "pending" countdown
  useEffect(() => {
    if (!claimPending) return;
    const timer = setInterval(() => {
      setClaimPending((prev) => {
        if (!prev) return null;
        if (prev.countdown <= 1) return null;
        return { ...prev, countdown: prev.countdown - 1 };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [claimPending]);

  // Clear pending claim when user becomes DJ
  useEffect(() => {
    if (user && room && user.id === room.djUserId && claimPending) {
      setClaimPending(null);
    }
  }, [room?.djUserId, user?.id, claimPending]);

  // Track mobile viewport to gate mobile-only UI behavior.
  useEffect(() => {
    const onResize = () => setIsMobileLayout(window.innerWidth <= 600);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Persist the web-only EQ preset per browser.
  useEffect(() => {
    localStorage.setItem('eq-mode', eqMode);
  }, [eqMode]);

  // Tag the document for web mode so CSS can use a roomier desktop layout. Discord
  // keeps the compact fixed-size panel; mobile rules are unaffected.
  useEffect(() => {
    document.body.classList.toggle('web-mode', isWebMode);
  }, []);

  // Discord init + socket
  useEffect(() => {
    async function init() {
      // Use a stable dev ID stored in localStorage so hot-reloads don't break isDJ
      let stableDevId = localStorage.getItem('dev-user-id');
      if (!stableDevId) {
        stableDevId = `dev-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem('dev-user-id', stableDevId);
      }
      let userData = { id: stableDevId, username: 'Dev User' };
      // Web isolation: each visitor gets a private "solo:" room by default. A "Listen
      // Together" link (/room/CODE) joins the shared "lt:" room instead. Discord sets
      // channelId from the voice channel below.
      //
      // The solo key is tied to a per-tab sessionStorage id (not localStorage) so the
      // queue persists across reloads/navigation within the same browser session but
      // starts fresh when the tab/browser is closed — "session only" persistence.
      let sessionId = sessionStorage.getItem('solo-session-id');
      if (!sessionId) {
        sessionId = `s-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem('solo-session-id', sessionId);
      }
      const urlRoomCode = isWebMode ? getRoomCodeFromUrl() : null;
      let channelId = urlRoomCode ? `lt:${urlRoomCode}` : `solo:${sessionId}`;

      if (discordSdk) {
        // The voice-channel id comes from the activity launch URL (?channel_id=) and is
        // available on the SDK immediately — independent of the auth handshake. Pin the
        // persistent per-channel room key NOW so the queue still persists even if auth
        // later fails or times out. instanceId changes per launch, so it is NOT used for
        // the persistent key; we only fall back to solo: when there is no channel at all.
        if (discordSdk.channelId) {
          channelId = `discord:${discordSdk.channelId}`;
        }
        try {
          // Hard 15-second cap on the ENTIRE Discord handshake (ready + authorize +
          // token exchange) so a stalled authorize dialog or unreachable server never
          // leaves the app on the loading screen indefinitely.
          await Promise.race([
            (async () => {
              await discordSdk.ready();
              // channelId may not have been on the URL at construction in some launch
              // contexts; re-read after ready() now that the SDK is fully initialised.
              if (discordSdk.channelId) {
                channelId = `discord:${discordSdk.channelId}`;
              }
              // Patch fetch, WebSocket, and XHR so requests to our server
              // are routed through Discord's /.proxy/ path instead of cross-origin.
              const targetHost = new URL(resolvedServerUrl).host;
              patchUrlMappings([{ prefix: '/', target: targetHost }]);
              const { code } = await discordSdk.commands.authorize({
                client_id: DISCORD_CLIENT_ID,
                response_type: 'code',
                state: '',
                prompt: 'none',
                scope: ['identify'],
              });
              const tokenRes = await fetch('/api/discord/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
              });
              if (!tokenRes.ok) throw new Error('Token exchange failed');
              const { access_token } = await tokenRes.json();
              const auth = await discordSdk.commands.authenticate({ access_token });
              userData = auth.user;
            })(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Discord init timeout')), 15000)
            ),
          ]);
        } catch (err) {
          console.error('Discord auth error:', err);
        }
      }

      setUser(userData);
      setDefaultChannelId(channelId);
      setReady(true);
    }
    init();
  }, [resolvedServerUrl]);

  // Socket connection. Re-runs when the effective room changes (e.g. a Discord user
  // joins/leaves a Listen Together party), reconnecting in place without a page reload.
  const effectiveChannelId = discordPartyCode ? `lt:${discordPartyCode}` : defaultChannelId;
  // Queue memory applies to a private web session only. A party's queue belongs to
  // the party, and Discord rooms are the voice channel's, not this browser's.
  const isSoloWebSession = isWebMode && !!effectiveChannelId && effectiveChannelId.startsWith('solo:');
  useEffect(() => {
    if (!user || !effectiveChannelId) return;
    // Clear any prior room state so switching parties doesn't flash stale tracks.
    setRoom(null);
    // After patchUrlMappings, socket.io polling/WS to VITE_SERVER_URL is transparently
    // routed through Discord's /.proxy/ path. Force polling first — it always works
    // through Discord's HTTP proxy even if WebSocket upgrades are blocked by the sandbox.
    const socket = io(resolvedServerUrl, {
      path: '/socket.io',
      transports: ['polling', 'websocket'],
      query: { channelId: effectiveChannelId, userId: user.id, username: user.username },
    });
    // A per-tab session id means a returning visitor lands in a brand new, empty
    // room. If this browser remembered a queue, hand it back on the first state we
    // receive. Guarded to one attempt so later updates can't re-restore over live
    // changes; the server also refuses unless the room is still empty.
    let restoreAttempted = false;
    socket.on('room:state', (state) => {
      setRoom(state);
      if (restoreAttempted) return;
      restoreAttempted = true;
      if (!isSoloWebSession || (state?.queue?.length ?? 0) > 0) return;
      const remembered = loadRememberedQueue();
      if (remembered) socket.emit('queue:restore', remembered);
    });
    socket.on('dj:changed', ({ djUserId }) =>
      setRoom((prev) => (prev ? { ...prev, djUserId } : prev))
    );
    socket.on('dj:claim-request', ({ claimerId, claimerUsername }) => {
      setClaimRequest({ claimerId, claimerUsername, countdown: 10 });
    });
    socket.on('dj:claim-denied', () => setClaimPending(null));
    socket.on('dj:claim-cancelled', () => setClaimRequest(null));
    socket.on('spotify-auth', (data) => {
      const { access_token, refresh_token, expires_in } = data;
      localStorage.setItem('spotify_refresh_token', refresh_token);
      setSpotifyToken({
        access_token,
        refresh_token,
        expires_at: Date.now() + parseInt(expires_in || '3600') * 1000,
      });
      setSpotifyRestoring(false);
    });

    socketRef.current = socket;
    socket.on('connect', () => setSocketId(socket.id));
    if (socket.connected) setSocketId(socket.id);

    return () => {
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [user, effectiveChannelId, resolvedServerUrl, isSoloWebSession]);

  // Keep this browser's copy of the solo queue current. Writing on queue changes
  // (rather than on every progress tick) keeps localStorage writes rare; the
  // pagehide handler catches the playback position on the way out.
  useEffect(() => {
    if (!isSoloWebSession || !rememberQueue || !room) return;
    const tracks = room.queue || [];
    if (tracks.length > 0) {
      sawTracksRef.current = true;
    } else if (!sawTracksRef.current) {
      // Still the empty room we connected to — the remembered queue may not have
      // been restored into it yet, so leave storage alone.
      return;
    }
    const persist = () => {
      if ((room.queue || []).length === 0) {
        // Emptied on purpose during this session; forget it.
        clearRememberedQueue();
        return;
      }
      saveRememberedQueue({
        queue: room.queue,
        currentIndex: room.currentIndex ?? 0,
        currentService: room.currentService,
        position: playerActionsRef.current.getPosition?.() || 0,
      });
    };
    persist();
    window.addEventListener('pagehide', persist);
    return () => window.removeEventListener('pagehide', persist);
  }, [isSoloWebSession, rememberQueue, room?.queue, room?.currentIndex, room?.currentService]);

  function handleRememberQueueChange(next) {
    setRememberQueueState(next);
    // Writes the preference, and erases the stored queue when switched off.
    setRememberQueue(next);
    if (!next) clearRememberedQueue();
  }

  const activeRoom = detached ? (detachedRoom ?? cloneRoomState(room)) : room;
  const currentTrack = activeRoom?.queue?.[activeRoom.currentIndex] ?? null;
  const activeService = detached ? (detachedService ?? activeRoom?.currentService) : room?.currentService;
  const isDJ = user?.id === room?.djUserId;
  // Next YouTube track to prefetch — browser will start buffering its audio while the
  // current song plays so the transition feels instant.
  const nextYoutubeTrack =
    activeRoom?.queue?.[activeRoom.currentIndex + 1]?.service === 'youtube'
      ? activeRoom.queue[activeRoom.currentIndex + 1]
      : null;

  // Mark whatever starts playing as played, however it was reached — a shuffle jump,
  // a manual pick from the queue, or a plain skip. That keeps a manually chosen song
  // from coming round again later in the same pass.
  useEffect(() => {
    const key = trackKey(currentTrack);
    if (key) shufflePassRef.current.add(key);
  }, [currentTrack?.id, currentTrack?.service]);

  // Ensure each track starts with a fresh timeline in the UI.
  useEffect(() => {
    if (!currentTrack) {
      setProgress(0);
      setDuration(0);
      return;
    }
    const initial = Number(activeRoom?.position || 0);
    setProgress(Number.isFinite(initial) ? Math.max(0, initial) : 0);
    setDuration(0);
  }, [currentTrack?.id, activeService, detached]);

  // Warm the server-side YouTube URL cache for upcoming songs so skip starts faster.
  useEffect(() => {
    if (!activeRoom?.queue?.length) return;
    if (activeService !== 'youtube') return;
    if (!isDJ && !detached) return;

    const activeYoutubeIds = new Set(
      activeRoom.queue
        .filter((track) => track?.service === 'youtube' && track?.id)
        .map((track) => track.id)
    );
    for (const id of preloadedYoutubeIdsRef.current) {
      if (!activeYoutubeIds.has(id)) {
        preloadedYoutubeIdsRef.current.delete(id);
      }
    }

    const startIndex = Math.max(0, (activeRoom.currentIndex ?? -1) + 1);
    const preloadCandidates = activeRoom.queue
      .slice(startIndex)
      .filter((track) => track?.service === 'youtube' && track?.id);

    preloadCandidates.forEach((track) => {
      if (preloadedYoutubeIdsRef.current.has(track.id)) return;
      preloadedYoutubeIdsRef.current.add(track.id);
      fetch(`/api/youtube/resolve/${encodeURIComponent(track.id)}`)
        .catch(() => {
          preloadedYoutubeIdsRef.current.delete(track.id);
        });
    });
  }, [activeRoom?.queue, activeRoom?.currentIndex, activeService, isDJ, detached]);

  // Ask about background playback the first time the listener actually leaves the
  // app with music going. Prompting as they leave would be pointless — they aren't
  // looking — so the question is raised when they come back.
  useEffect(() => {
    if (!isNativeApp() || backgroundPlayback !== null) return;
    let leftWhilePlaying = false;
    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        if (localPlaying) leftWhilePlaying = true;
        return;
      }
      if (leftWhilePlaying) {
        leftWhilePlaying = false;
        setShowBackgroundPrompt(true);
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [backgroundPlayback, localPlaying]);

  function answerBackgroundPrompt(enabled) {
    writeBackgroundPreference(enabled);
    setBackgroundPlayback(enabled ? 'on' : 'off');
    setShowBackgroundPrompt(false);
  }

  // Lock-screen / notification / media-key controls. Must sit above the early
  // return below — hooks can't be called conditionally. Guarded internally for
  // Android WebView, which has no Media Session API at all.
  useMediaSession({
    nativeEnabled: backgroundPlayback === 'on',
    track: currentTrack,
    service: activeService,
    localPlaying,
    isDJ,
    detached,
    playerActionsRef,
    onNext: () => skip(),
    onSeek: (seconds) => handleSeek(seconds),
    onStop: () => stopPlayback(),
  });

  if (!ready || !room) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Connecting...</p>
      </div>
    );
  }

  function addTrack(track) {
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        const queue = [...roomState.queue, { ...track, addedBy: user?.username || 'You' }];
        const shouldStart =
          roomState.currentIndex === -1 ||
          !roomState.isPlaying;
        return {
          ...roomState,
          queue,
          currentIndex: shouldStart ? queue.length - 1 : roomState.currentIndex,
          isPlaying: shouldStart ? true : roomState.isPlaying,
          position: shouldStart ? 0 : roomState.position,
          syncedAt: Date.now(),
        };
      });
      return;
    }
    socketRef.current?.emit('queue:add', track);
  }

  function playTrack(track) {
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        const queue = [...roomState.queue, { ...track, addedBy: user?.username || 'You' }];
        return {
          ...roomState,
          queue,
          currentIndex: queue.length - 1,
          isPlaying: true,
          position: 0,
          syncedAt: Date.now(),
        };
      });
      return;
    }
    socketRef.current?.emit('queue:play-track', track);
  }

  function loadPlaylist(tracks) {
    // A different set of songs means the old pass no longer describes anything.
    resetShufflePass(null);
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        return {
          ...roomState,
          queue: tracks.map((track) => ({ ...track, addedBy: user?.username || 'You' })),
          currentIndex: tracks.length > 0 ? 0 : -1,
          isPlaying: tracks.length > 0,
          position: 0,
          syncedAt: Date.now(),
        };
      });
      return;
    }
    socketRef.current?.emit('queue:load-playlist', tracks);
  }

  // End playback for real: the room flag alone leaves this listener's own player
  // running, which is audible if they reached the end by pressing skip rather than
  // by letting the last track finish.
  function stopPlayback() {
    playerActionsRef.current.pause?.();
    setLocalPlaying(false);
    socketRef.current?.emit('player:sync', { position: 0, isPlaying: false });
  }

  function skip() {
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        if (roomState.queue.length === 0) {
          return { ...roomState, currentIndex: -1, isPlaying: false, position: 0, syncedAt: Date.now() };
        }
        if (shuffle && roomState.queue.length > 1) {
          const remaining = unplayedIndices(roomState.queue, roomState.currentIndex);
          if (remaining.length > 0) {
            return { ...roomState, currentIndex: pickRandom(remaining), position: 0, syncedAt: Date.now(), isPlaying: true };
          }
          resetShufflePass(null);
          if (loop === 'off') {
            playerActionsRef.current.pause?.();
            return { ...roomState, isPlaying: false, position: 0, syncedAt: Date.now() };
          }
          const all = roomState.queue.map((_, i) => i).filter((i) => i !== roomState.currentIndex);
          return {
            ...roomState,
            currentIndex: all.length > 0 ? pickRandom(all) : 0,
            position: 0,
            syncedAt: Date.now(),
            isPlaying: true,
          };
        }
        if (roomState.currentIndex < roomState.queue.length - 1) {
          return {
            ...roomState,
            currentIndex: roomState.currentIndex + 1,
            position: 0,
            syncedAt: Date.now(),
            isPlaying: true,
          };
        }
        if (loop !== 'off') {
          return { ...roomState, currentIndex: 0, isPlaying: true, position: 0, syncedAt: Date.now() };
        }
        // loop is off, at end of queue → stop
        return { ...roomState, isPlaying: false, position: 0, syncedAt: Date.now() };
      });
      return;
    }
    // DJ path
    if (shuffle && room.queue.length > 1) {
      const remaining = unplayedIndices(room.queue, room.currentIndex);
      if (remaining.length > 0) {
        socketRef.current?.emit('queue:play-now', pickRandom(remaining));
        return;
      }
      // Every song has had its turn. Loop off means the shuffle is finished, not
      // that it should keep picking at random forever.
      resetShufflePass(null);
      if (loop === 'off') {
        stopPlayback();
        return;
      }
      const all = room.queue.map((_, i) => i).filter((i) => i !== room.currentIndex);
      socketRef.current?.emit('queue:play-now', all.length > 0 ? pickRandom(all) : 0);
      return;
    }
    if (loop === 'off' && room.queue.length > 0 && room.currentIndex >= room.queue.length - 1) {
      // At end of queue and loop is off → stop playback
      stopPlayback();
      return;
    }
    socketRef.current?.emit('queue:skip');
  }

  function shuffleQueue() {
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        if (roomState.queue.length <= 1) return roomState;
        const currentTrack = roomState.queue[roomState.currentIndex];
        const q = [...roomState.queue];
        for (let i = q.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [q[i], q[j]] = [q[j], q[i]];
        }
        const newIndex = currentTrack ? q.indexOf(currentTrack) : 0;
        return { ...roomState, queue: q, currentIndex: newIndex >= 0 ? newIndex : 0, syncedAt: Date.now() };
      });
      return;
    }
    socketRef.current?.emit('queue:shuffle');
  }

  function syncPlayer(data) {
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        return {
          ...roomState,
          position: typeof data?.position === 'number' ? data.position : roomState.position,
          isPlaying: typeof data?.isPlaying === 'boolean' ? data.isPlaying : roomState.isPlaying,
          syncedAt: Date.now(),
        };
      });
      return;
    }
    socketRef.current?.emit('player:sync', data);
  }
  function switchService(service) { socketRef.current?.emit('service:switch', service); }
  function handleServiceChange(service) {
    if (detached) {
      setDetachedService(service);
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        return { ...roomState, currentService: service };
      });
    } else {
      switchService(service);
    }
  }
  function removeTrack(index) {
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        if (typeof index !== 'number' || index < 0 || index >= roomState.queue.length) return roomState;
        const queue = [...roomState.queue];
        const [removedTrack] = queue.splice(index, 1);
        let deletedHistory = roomState.deletedHistory || [];
        if (removedTrack) {
          const key = `${removedTrack.service || 'youtube'}:${removedTrack.id}`;
          const existing = deletedHistory.find((h) => `${h?.service || 'youtube'}:${h?.id || ''}` === key);
          const updatedEntry = {
            ...removedTrack,
            deletedBy: user?.username || 'You',
            deletedAt: Date.now(),
            timesDeleted: Number(existing?.timesDeleted || 0) + 1,
          };
          deletedHistory = deletedHistory
            .filter((h) => `${h?.service || 'youtube'}:${h?.id || ''}` !== key)
            .concat(updatedEntry);
        }
        let currentIndex = roomState.currentIndex;
        let isPlaying = roomState.isPlaying;
        let position = roomState.position;
        if (queue.length === 0) {
          currentIndex = -1;
          isPlaying = false;
          position = 0;
        } else if (index === currentIndex) {
          currentIndex = Math.min(currentIndex, queue.length - 1);
          position = 0;
        } else if (index < currentIndex) {
          currentIndex = Math.max(0, currentIndex - 1);
        }
        return {
          ...roomState,
          queue,
          deletedHistory,
          currentIndex,
          isPlaying,
          position,
          syncedAt: Date.now(),
        };
      });
      return;
    }
    socketRef.current?.emit('queue:remove', index);
  }
  function playNow(index) {
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        if (typeof index !== 'number' || index < 0 || index >= roomState.queue.length) return roomState;
        const nextTrack = roomState.queue[index];
        if (nextTrack?.service === 'youtube' && nextTrack?.id) {
          fetch(`/api/youtube/resolve/${encodeURIComponent(nextTrack.id)}`).catch(() => {});
        }
        return {
          ...roomState,
          currentIndex: index,
          position: 0,
          syncedAt: Date.now(),
          isPlaying: true,
        };
      });
      return;
    }
    const nextTrack = activeRoom?.queue?.[index];
    if (nextTrack?.service === 'youtube' && nextTrack?.id) {
      fetch(`/api/youtube/resolve/${encodeURIComponent(nextTrack.id)}`).catch(() => {});
    }
    socketRef.current?.emit('queue:play-now', index);
  }
  function reorderQueue(from, to) {
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        if (typeof from !== 'number' || typeof to !== 'number') return roomState;
        if (from < 0 || from >= roomState.queue.length || to < 0 || to >= roomState.queue.length) return roomState;
        if (from === to) return roomState;

        const queue = [...roomState.queue];
        const [moved] = queue.splice(from, 1);
        queue.splice(to, 0, moved);

        let currentIndex = roomState.currentIndex;
        if (currentIndex === from) {
          currentIndex = to;
        } else if (from < currentIndex && to >= currentIndex) {
          currentIndex -= 1;
        } else if (from > currentIndex && to <= currentIndex) {
          currentIndex += 1;
        }

        return { ...roomState, queue, currentIndex, syncedAt: Date.now() };
      });
      return;
    }
    socketRef.current?.emit('queue:reorder', { from, to });
  }
  function clearQueue() {
    resetShufflePass(null);
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        const deletedMap = new Map();
        for (const item of roomState.deletedHistory || []) {
          deletedMap.set(`${item?.service || 'youtube'}:${item?.id || ''}`, item);
        }
        const now = Date.now();
        for (const track of roomState.queue) {
          if (!track?.id) continue;
          const key = `${track.service || 'youtube'}:${track.id}`;
          const existing = deletedMap.get(key);
          const entry = {
            ...track,
            deletedBy: user?.username || 'You',
            deletedAt: now,
            timesDeleted: Number(existing?.timesDeleted || 0) + 1,
          };
          deletedMap.set(key, entry);
        }
        const deletedHistory = Array.from(deletedMap.values());
        return {
          ...roomState,
          queue: [],
          deletedHistory,
          currentIndex: -1,
          isPlaying: false,
          position: 0,
          syncedAt: Date.now(),
        };
      });
      return;
    }
    socketRef.current?.emit('queue:clear');
  }
  function clearHistory() {
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        return {
          ...roomState,
          deletedHistory: [],
          syncedAt: Date.now(),
        };
      });
      return;
    }
    socketRef.current?.emit('history:clear');
  }
  function claimDJ() { 
    if (detached) return;
    socketRef.current?.emit('dj:claim'); 
    setClaimPending({ claimerUsername: user?.username || 'You', countdown: 10 });
  }
  function respondToClaim(approved) {
    socketRef.current?.emit('dj:claim-respond', { approved });
    setClaimRequest(null);
  }
  function cancelClaimRequest() {
    socketRef.current?.emit('dj:claim-cancel');
    setClaimPending(null);
  }
  function handlePlayerReady(actions) {
    playerActionsRef.current = actions;
    // Push the current level at the new player. Without this the UI showed a
    // volume the player had never been told about — it ran at full until the
    // slider was touched, so the displayed level was a lie on every fresh load.
    actions.setVolume?.(gainFromPosition(volume));
  }

  function handleBalanceToggle() {
    setBalance((previous) => {
      const next = !previous;
      localStorage.setItem('balance-mode', next ? 'on' : 'off');
      return next;
    });
  }
  function handlePlayToggle() { playerActionsRef.current.toggle(); }
  function handleSeek(s) {
    playerActionsRef.current.seek?.(s);
    syncPlayer({ position: s, isPlaying: localPlaying });
  }
  function handleVolumeChange(position) {
    setVolume(position);
    try {
      localStorage.setItem('volume-position', String(position));
    } catch {
      // Private mode / quota — the level just won't persist.
    }
    playerActionsRef.current.setVolume?.(gainFromPosition(position));
  }
  function handleDebugEvent(patch) {
    setDebugInfo((prev) => ({
      ...prev,
      ...patch,
      updatedAt: Date.now(),
    }));
  }

  const isPlaying = isDJ || detached ? localPlaying : room.isPlaying;

  return (
    <div className="app">
      {/* Left column: player */}
      <div className="app-left">
        <header className="app-header">
          <svg className="header-vinyl" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" width="22" height="22" aria-hidden="true">
            <circle cx="50" cy="50" r="48" fill="#18191c"/>
            <circle cx="50" cy="50" r="40" fill="none" stroke="#3a3b40" stroke-width="1.5"/>
            <circle cx="50" cy="50" r="32" fill="none" stroke="#3a3b40" stroke-width="1.5"/>
            <circle cx="50" cy="50" r="22" fill="#5865f2"/>
            <text x="50" y="57" textAnchor="middle" fontSize="20" fill="white" fontFamily="sans-serif">♪</text>
            <circle cx="50" cy="50" r="3.5" fill="#18191c"/>
          </svg>
          <h1 className="app-title-text">Music</h1>
          <span className="app-header-spacer" />
          <button
            className={`mobile-service-toggle ${activeService === 'spotify' ? 'spotify' : 'youtube'}`}
            onClick={() => handleServiceChange(activeService === 'youtube' ? 'spotify' : 'youtube')}
            disabled={!isDJ && !detached}
            title={detached ? 'Switch your local service (detached mode)' : (!isDJ ? 'Only the DJ can switch services' : 'Toggle service')}
          >
            {activeService === 'youtube' ? '▶ YouTube' : '♪ Spotify'}
          </button>
          <DJBadge isDJ={isDJ} />
          {!isDJ && (
            <button
              className="btn-claim-dj"
              onClick={claimDJ}
              disabled={detached}
              title={detached ? 'Rejoin the group to claim DJ' : 'Become the DJ if the current DJ is offline'}
            >
              Claim DJ
            </button>
          )}
          {isWebMode ? (
            <ListenTogether
              roomCode={roomCode}
              serverUrl={resolvedServerUrl}
              // Starting a party carries the solo session's music into the new
              // room. Read live at click time so the playhead is accurate.
              getSeedState={() => ({
                queue: activeRoom?.queue || [],
                currentIndex: activeRoom?.currentIndex ?? -1,
                currentService: activeService,
                position: playerActionsRef.current.getPosition?.() || 0,
                isPlaying,
              })}
            />
          ) : (
            <>
              <DiscordParty
                partyCode={discordPartyCode}
                onJoin={(code) => {
                  setDetached(false);
                  setDetachedService(null);
                  setDetachedRoom(null);
                  setDiscordPartyCode(code);
                }}
                onLeave={() => setDiscordPartyCode(null)}
              />
              {!discordPartyCode && (
                <button
                  className={`detach-btn ${detached ? 'active' : ''}`}
                  onClick={() => {
                    if (detached) {
                      setDetached(false);
                      setDetachedService(null);
                      setDetachedRoom(null);
                    } else {
                      setDetachedRoom(cloneRoomState(room));
                      setLocalPlaying(false);
                      setDetached(true);
                    }
                  }}
                >
                  {detached ? '← Rejoin' : 'Detach'}
                </button>
              )}
            </>
          )}
        </header>

        {/* Install prompt: mobile browsers only. The Discord activity and the
            packaged app both suppress it (see InstallAppBanner). */}
        {isWebMode && isMobileLayout && <InstallAppBanner />}

        <div className="service-row">
          <ServiceSelector
            current={detached ? (detachedService ?? activeRoom.currentService) : room.currentService}
            onChange={handleServiceChange}
            isDJ={isDJ}
            detached={detached}
          />
          {isWebMode && (
            <a
              className="add-to-discord-btn"
              href="https://discord.com/oauth2/authorize?client_id=1492382387139772476"
              target="_blank"
              rel="noopener noreferrer"
              title="Add this app to your Discord server"
            >
              ✛ Add to Discord
            </a>
          )}
        </div>

        <div className="now-playing">
          {activeService === 'youtube' ? (
            <YouTubePlayer
              track={currentTrack}
              room={activeRoom}
              isDJ={isDJ}
              detached={detached}
              onSync={syncPlayer}
              onSkip={skip}
              loop={loop}
              onPlayerReady={handlePlayerReady}
              onPlayStateChange={setLocalPlaying}
              onDebugEvent={handleDebugEvent}
              eqMode={isWebMode ? eqMode : 'flat'}
              balance={balance}
            />
          ) : spotifyToken ? (
            <SpotifyPlayer
              track={currentTrack}
              room={activeRoom}
              isDJ={isDJ}
              detached={detached}
              spotifyToken={spotifyToken}
              onSync={syncPlayer}
              onSkip={skip}
              loop={loop}
              onPlayerReady={handlePlayerReady}
              onPlayStateChange={setLocalPlaying}
              onDebugEvent={handleDebugEvent}
            />
          ) : (
            <div className="album-art no-art">
              <svg className="vinyl-idle" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" width="48" height="48" aria-hidden="true">
                <defs>
                  <radialGradient id="noartShine" cx="38%" cy="33%" r="55%">
                    <stop offset="0%" stopColor="white" stopOpacity="0.15"/>
                    <stop offset="100%" stopColor="black" stopOpacity="0.1"/>
                  </radialGradient>
                </defs>
                <circle cx="50" cy="50" r="48" fill="#18191c"/>
                <circle cx="50" cy="50" r="43" fill="none" stroke="#2c2d31" stroke-width="1.5"/>
                <circle cx="50" cy="50" r="37" fill="none" stroke="#2c2d31" stroke-width="1.5"/>
                <circle cx="50" cy="50" r="31" fill="none" stroke="#2c2d31" stroke-width="1.5"/>
                <circle cx="50" cy="50" r="25" fill="none" stroke="#2c2d31" stroke-width="1.5"/>
                <circle cx="50" cy="50" r="22" fill="#5865f2"/>
                <circle cx="50" cy="50" r="22" fill="url(#noartShine)"/>
                <text x="50" y="57" textAnchor="middle" fontSize="20" fill="white" fontFamily="sans-serif">♪</text>
                <circle cx="50" cy="50" r="3.5" fill="#18191c"/>
              </svg>
            </div>
          )}

          <div className="now-playing-info">
            {currentTrack ? (
              <>
                <div className="np-title">{currentTrack.title}</div>
                <div className="np-artist">{currentTrack.artist || ''}</div>
              </>
            ) : (
              <div className="np-empty">Add a track to get started</div>
            )}
          </div>
        </div>

        {isWebMode && activeService === 'youtube' && (
          <EqSelector value={eqMode} onChange={setEqMode} />
        )}

        {isSoloWebSession && (
          <QueueMemory
            enabled={rememberQueue}
            onChange={handleRememberQueueChange}
            trackCount={activeRoom?.queue?.length || 0}
          />
        )}

        <div className="app-queue-slot">
          <Queue
            queue={activeRoom.queue}
            currentIndex={activeRoom.currentIndex}
            isDJ={isDJ || detached}
            onRemove={removeTrack}
            onPlayNow={playNow}
            onReorder={reorderQueue}
            onClearQueue={clearQueue}
            onShuffleQueue={shuffleQueue}
          />
        </div>

        <PlayerControls
          isPlaying={isPlaying}
          progress={progress}
          duration={duration}
          isDJ={isDJ}
          detached={detached}
          volume={volume}
          balance={balance}
          onBalanceToggle={handleBalanceToggle}
          // Balance lives in our own audio graph; Spotify plays through its SDK,
          // which we don't route, so the control would do nothing there.
          balanceAvailable={activeService === 'youtube'}
          backgroundAvailable={isNativeApp()}
          backgroundEnabled={backgroundPlayback === 'on'}
          onBackgroundToggle={() => answerBackgroundPrompt(backgroundPlayback !== 'on')}
          expanded={isMobileLayout || !showDebug}
          shuffle={shuffle}
          loop={loop}
          onShuffleToggle={() =>
            setShuffle((on) => {
              // Switching shuffle on starts a fresh pass from whatever is playing.
              if (!on) resetShufflePass(currentTrack);
              return !on;
            })
          }
          onLoopToggle={() => setLoop((l) => l === 'off' ? 'track' : l === 'track' ? 'queue' : 'off')}
          onPlayToggle={handlePlayToggle}
          onSkip={skip}
          onSeek={handleSeek}
          onVolumeChange={handleVolumeChange}
          currentTrack={currentTrack}
        />

        {!isMobileLayout && (
          <button
            className="debug-toggle-btn"
            onClick={() => setShowDebug(!showDebug)}
            aria-expanded={showDebug}
          >
            {showDebug ? '▲ Hide Debugging ▲' : '▼ Show Debugging ▼'}
          </button>
        )}

        {!isMobileLayout && showDebug && (
          <div className="debug-strip" role="status" aria-live="polite">
            <span className="debug-chip">svc: {activeService}</span>
            {activeService === 'youtube' ? (
              <span className="debug-chip">status: YouTube ready</span>
            ) : (
              <span className="debug-chip">status: {spotifyToken ? 'Spotify connected' : 'Spotify auth required'}</span>
            )}
            <span className="debug-chip">room: {room.isPlaying ? 'playing' : 'paused'}</span>
            <span className="debug-chip">local: {localPlaying ? 'playing' : 'paused'}</span>
            <span className="debug-chip">player: {debugInfo.playerState || '-'}</span>
            <span className="debug-chip">blocked: {debugInfo.autoplayBlocked ? 'yes' : 'no'}</span>
            <span className="debug-chip">sdk: {debugInfo.spotifySdkReady ? 'ready' : 'idle'}</span>
            <span className="debug-chip">dev: {debugInfo.spotifyDeviceId || '-'}</span>
            <span className="debug-chip">playAPI: {debugInfo.spotifyLastPlayStatus || '-'}</span>
            <span className="debug-chip">evt: {debugInfo.lastEvent || '-'}</span>
          </div>
        )}
      </div>

      {/* Right column: search */}
      <div className="app-right">
        <Search
          service={activeService}
          spotifyToken={spotifyToken?.access_token}
          spotifyRestoring={spotifyRestoring}
          queue={activeRoom.queue}
          deletedHistory={activeRoom.deletedHistory || []}
          isDJ={isDJ}
          canManageHistory={isDJ || detached}
          onAdd={addTrack}
          onPlayTrack={playTrack}
          onLoadPlaylist={loadPlaylist}
          onClearHistory={clearHistory}
          onSpotifyLogin={spotifyLoginUrl}
          onSpotifyLogout={() => {
            localStorage.removeItem('spotify_refresh_token');
            setSpotifyToken(null);
            setSpotifyRestoring(false);
          }}
        />
        <div className="app-right-fill" />
      </div>

      {/* DJ claim modal — shown to DJ when someone requests */}
      {claimRequest && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h2>DJ Takeover Request</h2>
            </div>
            <div className="modal-body">
              <p><strong>{claimRequest.claimerUsername}</strong> wants to take over as DJ</p>
              <div className="countdown-ring">
                <div className="countdown-text">{claimRequest.countdown}s</div>
              </div>
              <p className="countdown-note">Respond within {claimRequest.countdown} seconds or role transfers</p>
            </div>
            <div className="modal-footer">
              <button className="btn-deny" onClick={() => respondToClaim(false)}>Deny</button>
              <button className="btn-approve" onClick={() => respondToClaim(true)}>Approve</button>
            </div>
          </div>
        </div>
      )}

      {/* Claimer toast — shown to non-DJ when they request */}
      {claimPending && (
        <div className="toast-claim-pending">
          <div className="toast-content">
            <div className="toast-message">Requesting DJ role...</div>
            <div className="toast-countdown">{claimPending.countdown}s</div>
            <button className="btn-toast-cancel" onClick={cancelClaimRequest} title="Cancel DJ request">×</button>
          </div>
        </div>
      )}

      {showBackgroundPrompt && (
        <BackgroundPlaybackPrompt
          onAllow={() => answerBackgroundPrompt(true)}
          onDecline={() => answerBackgroundPrompt(false)}
        />
      )}

      {/* Prefetch the next YouTube track's audio while the current song plays.
          preload="auto" tells the browser to buffer the full file so the switch
          is near-instant. The key must change when the next track changes so
          React creates a fresh element (and starts a fresh download). */}
      {nextYoutubeTrack && activeService === 'youtube' && (
        <audio
          key={nextYoutubeTrack.id}
          src={`/api/youtube/audio/${encodeURIComponent(nextYoutubeTrack.id)}`}
          preload="auto"
          style={{ display: 'none' }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

