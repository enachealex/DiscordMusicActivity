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
  loop,
  onSync,
  onSkip,
  onPlayerReady,
  onPlayStateChange,
  onDebugEvent,
}) {
  const audioRef = useRef(null);
  const syncTimerRef = useRef(null);
  const retryCountRef = useRef(0);
  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const compressorNodeRef = useRef(null);
  const outputGainNodeRef = useRef(null);
  const [needsInteraction, setNeedsInteraction] = useState(false);

  function ensureAudioProcessing(audio) {
    if (!audio || sourceNodeRef.current) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx = audioContextRef.current || new AudioCtx();
      audioContextRef.current = ctx;

      const source = ctx.createMediaElementSource(audio);
      const compressor = ctx.createDynamicsCompressor();
      const outputGain = ctx.createGain();

      // Gentle loudness smoothing: reduce sudden peaks while keeping tone natural.
      compressor.threshold.value = -24;
      compressor.knee.value = 24;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.22;
      outputGain.gain.value = 1.05;

      source.connect(compressor);
      compressor.connect(outputGain);
      outputGain.connect(ctx.destination);

      sourceNodeRef.current = source;
      compressorNodeRef.current = compressor;
      outputGainNodeRef.current = outputGain;
      onDebugEvent?.({ service: 'youtube', lastEvent: 'yt:dsp-enabled' });
    } catch {
      // WebAudio setup can fail in restrictive embeds; fallback to regular element audio.
    }
  }

  function resumeAudioProcessingContext() {
    const ctx = audioContextRef.current;
    if (ctx?.state === 'suspended') {
      ctx.resume().catch(() => {
        // Ignore resume failure; normal playback path still runs.
      });
    }
  }

  function registerActions(audio) {
    onPlayerReady?.({
      toggle: () => {
        if (!audio) return;
        if (audio.paused) {
          resumeAudioProcessingContext();
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
    resumeAudioProcessingContext();
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
    ensureAudioProcessing(audio);
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
      if (loop === 'track') {
        audio.currentTime = 0;
        audio.play().catch(() => setNeedsInteraction(true));
        return;
      }
      if (isDJ || detached) onSkip?.();
    };
    const onWaiting = () => {
      onDebugEvent?.({ service: 'youtube', playerState: 'buffering', lastEvent: 'yt:buffering' });
    };
    const onError = () => {
      const code = audio.error?.code ?? 'unknown';
      onDebugEvent?.({ service: 'youtube', playerState: 'error', lastEvent: `yt:audio-error:${code}` });
      // One automatic retry per track — appends ?fresh=1 to force the server to
      // evict any stale yt-dlp URL and re-resolve before streaming.
      if (retryCountRef.current < 1) {
        retryCountRef.current++;
        setTimeout(() => {
          const a = audioRef.current;
          if (!a || !track) return;
          a.src = `/api/youtube/audio/${encodeURIComponent(track.id)}?fresh=1`;
          a.load();
        }, 500);
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
      resumeAudioProcessingContext();
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
      resumeAudioProcessingContext();
      audio.play().catch(() => setNeedsInteraction(true));
    }
    if (!room.isPlaying && !audio.paused) {
      audio.pause();
    }
  }, [room]);

  useEffect(() => {
    return () => {
      sourceNodeRef.current?.disconnect();
      compressorNodeRef.current?.disconnect();
      outputGainNodeRef.current?.disconnect();
      sourceNodeRef.current = null;
      compressorNodeRef.current = null;
      outputGainNodeRef.current = null;
      const ctx = audioContextRef.current;
      audioContextRef.current = null;
      if (ctx && ctx.state !== 'closed') {
        ctx.close().catch(() => {
          // Ignore close errors during teardown.
        });
      }
    };
  }, []);

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
