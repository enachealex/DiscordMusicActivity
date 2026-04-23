import { useEffect, useRef, useState } from 'react';

function thumbSrc(url) {
  if (!url) return '';
  if (url.startsWith('/media/thumb')) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return `/media/thumb?src=${encodeURIComponent(url)}`;
  }
  return url;
}

export default function YouTubePlayer({
  track,
  room,
  isDJ,
  detached,
  onSync,
  onSkip,
  onPlayerReady,
  onPlayStateChange,
  onDebugEvent,
}) {
  const audioRef = useRef(null);
  const syncTimerRef = useRef(null);
  const retryCountRef = useRef(0);
  const [needsInteraction, setNeedsInteraction] = useState(false);

  function registerActions(audio) {
    onPlayerReady?.({
      toggle: () => {
        if (!audio) return;
        if (audio.paused) {
          audio.play().catch(() => setNeedsInteraction(true));
        } else {
          audio.pause();
        }
      },
      getPosition: () => audio?.currentTime ?? 0,
      getDuration: () => audio?.duration ?? 0,
      setVolume: (v) => {
        if (audio) audio.volume = Math.max(0, Math.min(1, v));
      },
      seek: (s) => {
        if (!audio || !Number.isFinite(audio.duration)) return;
        audio.currentTime = Math.max(0, Math.min(audio.duration, s));
      },
    });
  }

  function tryPlayWithRecovery() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.play()
      .then(() => {
        setNeedsInteraction(false);
        onDebugEvent?.({ service: 'youtube', playerState: 'playing', autoplayBlocked: false, lastEvent: 'yt:play-retry' });
      })
      .catch(() => {
        setNeedsInteraction(true);
        onDebugEvent?.({ service: 'youtube', autoplayBlocked: true, lastEvent: 'yt:play-retry-blocked' });
      });
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (!track || track.service !== 'youtube') {
      // Explicitly stop and unload prior media so mobile browsers don't keep audio alive.
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      onPlayStateChange?.(false);
      return;
    }

    retryCountRef.current = 0;
    registerActions(audio);
    audio.src = `/api/youtube/audio/${encodeURIComponent(track.id)}`;
    audio.load();

    const onLoadedMetadata = () => {
      const startSeconds = detached
        ? 0
        : Math.floor(room.position + (room.isPlaying ? (Date.now() - room.syncedAt) / 1000 : 0));
      if (Number.isFinite(audio.duration)) {
        audio.currentTime = Math.max(0, Math.min(audio.duration, startSeconds));
      }
      onDebugEvent?.({ service: 'youtube', playerState: 'ready', lastEvent: 'yt:audio-metadata' });
      if (room.isPlaying) tryPlayWithRecovery();
    };
    const onPlay = () => {
      setNeedsInteraction(false);
      onPlayStateChange?.(true);
      onDebugEvent?.({ service: 'youtube', playerState: 'playing', autoplayBlocked: false, lastEvent: 'yt:play' });
      if (isDJ || detached) {
        onSync?.({ position: audio.currentTime || 0, isPlaying: true });
      }
    };
    const onPause = () => {
      onPlayStateChange?.(false);
      onDebugEvent?.({ service: 'youtube', playerState: 'paused', lastEvent: 'yt:pause' });
      if (isDJ || detached) {
        onSync?.({ position: audio.currentTime || 0, isPlaying: false });
      }
    };
    const onEnded = () => {
      onDebugEvent?.({ service: 'youtube', playerState: 'ended', lastEvent: 'yt:ended' });
      if (isDJ || detached) onSkip?.();
    };
    const onWaiting = () => {
      onDebugEvent?.({ service: 'youtube', playerState: 'buffering', lastEvent: 'yt:buffering' });
    };
    const onError = () => {
      const code = audio.error?.code ?? 'unknown';
      onDebugEvent?.({ service: 'youtube', playerState: 'error', lastEvent: `yt:audio-error:${code}` });
      // One automatic retry per track — handles stale cached URLs that were evicted server-side.
      if (retryCountRef.current < 1) {
        retryCountRef.current++;
        setTimeout(() => {
          const a = audioRef.current;
          if (!a || !track) return;
          a.src = `/api/youtube/audio/${encodeURIComponent(track.id)}`;
          a.load();
        }, 2500);
      }
    };

    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('error', onError);

    onDebugEvent?.({ service: 'youtube', playerState: 'loading', lastEvent: 'yt:audio-load' });

    return () => {
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('error', onError);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, [track?.id, track?.service]);

  // Some embedded Discord sessions block autoplay with sound until user gesture.
  useEffect(() => {
    if (!needsInteraction) return;
    const unlockAudio = () => {
      tryPlayWithRecovery();
      setNeedsInteraction(false);
    };
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, [needsInteraction]);

  // Follower sync
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || isDJ || detached || !track || track.service !== 'youtube') return;
    const expected = room.position + (room.isPlaying ? (Date.now() - room.syncedAt) / 1000 : 0);
    if (Number.isFinite(audio.duration) && Math.abs((audio.currentTime || 0) - expected) > 2.5) {
      audio.currentTime = Math.max(0, Math.min(audio.duration, expected));
    }
    if (room.isPlaying && audio.paused) {
      audio.play().catch(() => setNeedsInteraction(true));
    }
    if (!room.isPlaying && !audio.paused) {
      audio.pause();
    }
  }, [room]);

  // DJ periodic sync ping
  useEffect(() => {
    if (!isDJ || detached) return;
    syncTimerRef.current = setInterval(() => {
      const audio = audioRef.current;
      if (!audio) return;
      onSync?.({
        position: audio.currentTime || 0,
        isPlaying: !audio.paused,
      });
    }, 5000);
    return () => clearInterval(syncTimerRef.current);
  }, [isDJ, detached]);

  return (
    <>
      <audio ref={audioRef} className="yt-audio-hidden" preload="auto" />
      <div className="album-art">
        {track?.thumbnail ? (
          <img src={thumbSrc(track.thumbnail)} alt="" />
        ) : (
          <span style={{ fontSize: 28 }}>▶</span>
        )}
      </div>
      {needsInteraction && (
        <button className="audio-unlock-btn" onClick={tryPlayWithRecovery} title="Enable audio playback">
          Enable audio
        </button>
      )}
    </>
  );
}
