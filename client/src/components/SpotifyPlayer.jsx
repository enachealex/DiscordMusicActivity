import { useEffect, useRef, useState } from 'react';

function thumbSrc(url) {
  if (!url) return '';
  if (url.startsWith('/media/thumb')) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return `/media/thumb?src=${encodeURIComponent(url)}`;
  }
  return url;
}

export default function SpotifyPlayer({
  track,
  room,
  isDJ,
  detached,
  spotifyToken,
  onSync,
  onSkip,
  onPlayerReady,
  onPlayStateChange,
  onDebugEvent,
}) {
  const playerRef = useRef(null);
  const deviceIdRef = useRef(null);
  const [deviceId, setDeviceId] = useState(null);
  const [sdkReady, setSdkReady] = useState(false);

  useEffect(() => {
    if (!spotifyToken) return;
    if (window.Spotify) { setSdkReady(true); return; }
    window.onSpotifyWebPlaybackSDKReady = () => setSdkReady(true);
    if (!document.getElementById('spotify-sdk')) {
      const script = document.createElement('script');
      script.id = 'spotify-sdk';
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      document.head.appendChild(script);
    }
  }, [!!spotifyToken]);

  useEffect(() => {
    if (!sdkReady || !spotifyToken?.access_token) return;
    onDebugEvent?.({ service: 'spotify', spotifySdkReady: true, lastEvent: 'sp:sdk-ready' });

    const player = new window.Spotify.Player({
      name: 'Discord Music Activity',
      getOAuthToken: (cb) => cb(spotifyToken.access_token),
      volume: 0.7,
    });

    player.addListener('ready', ({ device_id }) => {
      deviceIdRef.current = device_id;
      setDeviceId(device_id);
      onDebugEvent?.({
        service: 'spotify',
        spotifyDeviceId: device_id,
        playerState: 'ready',
        lastEvent: 'sp:device-ready',
      });
      onPlayerReady?.({
        toggle: () => player.togglePlay(),
        getPosition: () => 0,
        getDuration: () => 0,
        setVolume: (v) => player.setVolume(v),
        seek: (s) => player.seek(s * 1000),
      });
    });

    player.addListener('not_ready', () => {
      deviceIdRef.current = null;
      setDeviceId(null);
      onDebugEvent?.({
        service: 'spotify',
        spotifyDeviceId: '-',
        playerState: 'not-ready',
        lastEvent: 'sp:not-ready',
      });
    });

    player.addListener('initialization_error', ({ message }) => {
      onDebugEvent?.({ service: 'spotify', lastEvent: `sp:init-error:${message || 'unknown'}` });
    });
    player.addListener('authentication_error', ({ message }) => {
      onDebugEvent?.({ service: 'spotify', lastEvent: `sp:auth-error:${message || 'unknown'}` });
    });
    player.addListener('account_error', ({ message }) => {
      onDebugEvent?.({ service: 'spotify', lastEvent: `sp:account-error:${message || 'unknown'}` });
    });
    player.addListener('playback_error', ({ message }) => {
      onDebugEvent?.({ service: 'spotify', lastEvent: `sp:playback-error:${message || 'unknown'}` });
    });

    player.addListener('player_state_changed', (state) => {
      if (!state) return;
      onPlayStateChange?.(!state.paused);
      onDebugEvent?.({
        service: 'spotify',
        playerState: state.paused ? 'paused' : 'playing',
        lastEvent: `sp:state:${state.paused ? 'paused' : 'playing'}`,
      });
      if ((isDJ || detached)) {
        onSync?.({ position: state.position / 1000, isPlaying: !state.paused });
        if (state.paused && state.position === 0 && state.track_window.previous_tracks.length) {
          onSkip?.();
        }
      }
    });

    player.connect();
    playerRef.current = player;
    return () => { player.disconnect(); playerRef.current = null; };
  }, [sdkReady, spotifyToken?.access_token]);

  // Embedded browsers (including Discord Activity) may require a user gesture
  // before audio output is allowed for the Spotify Web Playback SDK.
  useEffect(() => {
    if (!playerRef.current) return;
    const unlockAudio = () => {
      playerRef.current?.activateElement?.();
      onDebugEvent?.({ service: 'spotify', lastEvent: 'sp:activate-element' });
      if (!deviceId || !spotifyToken?.access_token) return;
      if (!track || track.service !== 'spotify') return;
      if (!isDJ && !detached) return;
      fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${spotifyToken.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uris: [track.id] }),
      })
        .then((res) => {
          onDebugEvent?.({
            service: 'spotify',
            spotifyLastPlayStatus: `${res.status}`,
            lastEvent: `sp:play-unlock:${res.status}`,
          });
        })
        .catch((err) => {
          console.error(err);
          onDebugEvent?.({
            service: 'spotify',
            spotifyLastPlayStatus: 'error',
            lastEvent: 'sp:play-unlock:error',
          });
        });
    };

    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, [deviceId, spotifyToken?.access_token, track?.id, isDJ, detached]);

  useEffect(() => {
    if (!deviceId || !spotifyToken?.access_token) return;
    if (!track || track.service !== 'spotify') return;
    if (!isDJ && !detached) return;
    fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${spotifyToken.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: [track.id] }),
    })
      .then((res) => {
        onDebugEvent?.({
          service: 'spotify',
          spotifyLastPlayStatus: `${res.status}`,
          lastEvent: `sp:play:${res.status}`,
        });
      })
      .catch((err) => {
        console.error(err);
        onDebugEvent?.({
          service: 'spotify',
          spotifyLastPlayStatus: 'error',
          lastEvent: 'sp:play:error',
        });
      });
  }, [track?.id, deviceId, spotifyToken?.access_token, isDJ, detached]);

  // Render a small album art square (same slot as the YouTube mini-player)
  return (
    <div className="album-art">
      {track?.thumbnail ? (
        <img src={thumbSrc(track.thumbnail)} alt="" />
      ) : (
        <span style={{ fontSize: 28 }}>🎵</span>
      )}
    </div>
  );
}
