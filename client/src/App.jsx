import { useState, useEffect, useRef } from 'react';
import { DiscordSDK, patchUrlMappings } from '@discord/embedded-app-sdk';
import { io } from 'socket.io-client';
import ServiceSelector from './components/ServiceSelector.jsx';
import YouTubePlayer from './components/YouTubePlayer.jsx';
import SpotifyPlayer from './components/SpotifyPlayer.jsx';
import Queue from './components/Queue.jsx';
import Search from './components/Search.jsx';
import DJBadge from './components/DJBadge.jsx';
import PlayerControls from './components/PlayerControls.jsx';

const DISCORD_CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;

let discordSdk = null;
try {
  discordSdk = new DiscordSDK(DISCORD_CLIENT_ID);
} catch (e) {
  console.warn('Discord SDK unavailable:', e.message);
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);
  const [room, setRoom] = useState(null);
  const [detached, setDetached] = useState(false);
  const [detachedService, setDetachedService] = useState(null);
  const [detachedRoom, setDetachedRoom] = useState(null);
  const [showDebug, setShowDebug] = useState(false);
  const [spotifyToken, setSpotifyToken] = useState(null);
  const [spotifyRestoring, setSpotifyRestoring] = useState(
    () => !!localStorage.getItem('spotify_refresh_token')
  );
  const [localPlaying, setLocalPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.7);
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
  const socketRef = useRef(null);
  const playerActionsRef = useRef({ toggle: () => {}, getPosition: () => 0, getDuration: () => 0, setVolume: () => {}, seek: () => {} });

  function cloneRoomState(baseRoom) {
    if (!baseRoom) {
      return {
        queue: [],
        currentIndex: -1,
        isPlaying: false,
        currentService: 'youtube',
        position: 0,
        syncedAt: Date.now(),
      };
    }

    return {
      queue: [...(baseRoom.queue || [])],
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
      const serverOrigin = new URL(import.meta.env.VITE_SERVER_URL || window.location.origin).origin;
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
  }, []);

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
      window.history.replaceState({}, '', '/');
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
      if (dur > 0) { setProgress(pos); setDuration(dur); }
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
      let channelId = 'dev-channel';

      if (discordSdk) {
        try {
          // Race discordSdk.ready() against a 8-second timeout so the app
          // never hangs on the loading screen if the handshake fails.
          await Promise.race([
            discordSdk.ready(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Discord ready timeout')), 8000)
            ),
          ]);
          // Patch fetch, WebSocket, and XHR so requests to our server
          // are routed through Discord's /.proxy/ path instead of cross-origin.
          const targetHost = new URL(import.meta.env.VITE_SERVER_URL || window.location.origin).host;
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
          channelId = discordSdk.channelId ?? 'dev-channel';
        } catch (err) {
          console.error('Discord auth error:', err);
        }
      }

      setUser(userData);
      // After patchUrlMappings, socket.io polling/WS to VITE_SERVER_URL is
      // transparently routed through Discord's /.proxy/ path.
      // Force polling first — it always works through Discord's HTTP proxy
      // even if WebSocket upgrades are blocked by the activity sandbox.
      const serverUrl = import.meta.env.VITE_SERVER_URL || window.location.origin;
      const socket = io(serverUrl, {
        path: '/socket.io',
        transports: ['polling', 'websocket'],
        query: { channelId, userId: userData.id, username: userData.username },
      });
      socket.on('room:state', setRoom);
      socket.on('dj:changed', ({ djUserId }) =>
        setRoom((prev) => (prev ? { ...prev, djUserId } : prev))
      );

      // DJ receives a claim request
      socket.on('dj:claim-request', ({ claimerId, claimerUsername }) => {
        setClaimRequest({ claimerId, claimerUsername, countdown: 10 });
      });

      // Claimer is denied the DJ role
      socket.on('dj:claim-denied', () => {
        setClaimPending(null);
      });

      // DJ's request was cancelled by claimer
      socket.on('dj:claim-cancelled', () => {
        setClaimRequest(null);
      });

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
      setReady(true);
    }
    init();
    return () => socketRef.current?.disconnect();
  }, []);

  if (!ready || !room) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Connecting...</p>
      </div>
    );
  }

  const isDJ = user?.id === room.djUserId;
  const activeRoom = detached ? (detachedRoom ?? cloneRoomState(room)) : room;
  const currentTrack = activeRoom.queue[activeRoom.currentIndex] ?? null;

  function addTrack(track) {
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        const queue = [...roomState.queue, { ...track, addedBy: user?.username || 'You' }];
        const shouldStart = roomState.currentIndex === -1;
        return {
          ...roomState,
          queue,
          currentIndex: shouldStart ? 0 : roomState.currentIndex,
          isPlaying: shouldStart ? true : roomState.isPlaying,
          position: shouldStart ? 0 : roomState.position,
          syncedAt: Date.now(),
        };
      });
      return;
    }
    socketRef.current?.emit('queue:add', track);
  }

  function skip() {
    if (detached) {
      setDetachedRoom((prev) => {
        const roomState = prev ?? cloneRoomState(room);
        if (roomState.currentIndex < roomState.queue.length - 1) {
          return {
            ...roomState,
            currentIndex: roomState.currentIndex + 1,
            position: 0,
            syncedAt: Date.now(),
            isPlaying: true,
          };
        }
        return { ...roomState, isPlaying: false, position: 0, syncedAt: Date.now() };
      });
      return;
    }
    socketRef.current?.emit('queue:skip');
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
        queue.splice(index, 1);
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
        return { ...roomState, queue, currentIndex, isPlaying, position, syncedAt: Date.now() };
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
  function claimDJ() { 
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
  function handlePlayerReady(actions) { playerActionsRef.current = actions; }
  function handlePlayToggle() { playerActionsRef.current.toggle(); }
  function handleSeek(s) {
    playerActionsRef.current.seek?.(s);
    syncPlayer({ position: s, isPlaying: localPlaying });
  }
  function handleVolumeChange(v) {
    setVolume(v);
    playerActionsRef.current.setVolume?.(v);
  }
  function handleDebugEvent(patch) {
    setDebugInfo((prev) => ({
      ...prev,
      ...patch,
      updatedAt: Date.now(),
    }));
  }

  const isPlaying = isDJ || detached ? localPlaying : room.isPlaying;
  const activeService = detached ? (detachedService ?? activeRoom.currentService) : room.currentService;

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
          <h1 className="app-title">Music</h1>
          <DJBadge isDJ={isDJ} />
          {!isDJ && (
            <button className="btn-claim-dj" onClick={claimDJ} title="Become the DJ if the current DJ is offline">
              Claim DJ
            </button>
          )}
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
        </header>

        <ServiceSelector
          current={detached ? (detachedService ?? activeRoom.currentService) : room.currentService}
          onChange={handleServiceChange}
          isDJ={isDJ}
          detached={detached}
        />

        <div className="now-playing">
          {activeService === 'youtube' ? (
            <YouTubePlayer
              track={currentTrack}
              room={activeRoom}
              isDJ={isDJ}
              detached={detached}
              onSync={syncPlayer}
              onSkip={skip}
              onPlayerReady={handlePlayerReady}
              onPlayStateChange={setLocalPlaying}
              onDebugEvent={handleDebugEvent}
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

        <div className="app-left-fill" />

        <PlayerControls
          isPlaying={isPlaying}
          progress={progress}
          duration={duration}
          isDJ={isDJ}
          detached={detached}
          volume={volume}
          onPlayToggle={handlePlayToggle}
          onSkip={skip}
          onSeek={handleSeek}
          onVolumeChange={handleVolumeChange}
          currentTrack={currentTrack}
        />
        
        <button 
          className="debug-toggle-btn" 
          onClick={() => setShowDebug(!showDebug)}
          aria-expanded={showDebug}
        >
          {showDebug ? '▲ Hide Debugging ▲' : '▼ Show Debugging ▼'}
        </button>

        {showDebug && (
          <div className="debug-strip" role="status" aria-live="polite">
            <span className="debug-chip">svc: {activeService}</span>
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

      {/* Right column: search + queue */}
      <div className="app-right">
        <Search
          service={activeService}
          spotifyToken={spotifyToken?.access_token}
          spotifyRestoring={spotifyRestoring}
          queue={activeRoom.queue}
          onAdd={addTrack}
          onSpotifyLogin={() => {
            const serverOrigin = new URL(import.meta.env.VITE_SERVER_URL || window.location.origin).origin;
            const clientOrigin = window.location.origin;
            const socketId = socketRef.current?.id || '';
            const loginUrl = `${serverOrigin}/api/spotify/login?userId=${encodeURIComponent(user?.id || '')}&socketId=${encodeURIComponent(socketId)}&origin=${encodeURIComponent(serverOrigin)}&client_origin=${encodeURIComponent(clientOrigin)}`;
            
            try {
              if (discordSdk && window.parent !== window) {
                // Tell Discord to open the link natively in the user's browser
                discordSdk.commands.openExternalLink({ url: loginUrl }).catch(() => {
                  window.open(loginUrl, '_blank', 'noreferrer');
                });
              } else {
                window.open(loginUrl, '_blank', 'noreferrer');
              }
            } catch (err) {
              window.open(loginUrl, '_blank', 'noreferrer');
            }
          }}
          onSpotifyLogout={() => {
            localStorage.removeItem('spotify_refresh_token');
            setSpotifyToken(null);
            setSpotifyRestoring(false);
          }}
        />
        <Queue
          queue={activeRoom.queue}
          currentIndex={activeRoom.currentIndex}
          isDJ={isDJ || detached}
          onRemove={removeTrack}
          onPlayNow={playNow}
          onReorder={reorderQueue}
        />
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
    </div>
  );
}

