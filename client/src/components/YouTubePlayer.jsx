import { useEffect, useRef, useState } from 'react';

function thumbSrc(url) {
  if (!url) return '';
  if (url.startsWith('/media/thumb')) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return `/media/thumb?src=${encodeURIComponent(url)}`;
  }
  return url;
}

// EQ presets applied via two shelving BiquadFilters (low shelf = bass, high shelf =
// treble), in dB. Web-only feature; 'flat' is a no-op so Discord stays uncolored.
const EQ_PRESETS = {
  flat: { bass: 0, treble: 0 },
  bass: { bass: 6, treble: 0 },
  treble: { bass: 0, treble: 5 },
  vocal: { bass: -2, treble: 3 },
};

export default function YouTubePlayer({
  track,
  room,
  isDJ,
  detached,
  loop,
  eqMode = 'flat',
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
  const lowShelfRef = useRef(null);
  const highShelfRef = useRef(null);
  const [needsInteraction, setNeedsInteraction] = useState(false);

  // The media-event effect below is keyed to the track, so it must not re-run when
  // the room changes — re-running would reload the audio and restart the song. That
  // means its handlers close over whatever these were when the track started. Route
  // them through a ref that every render refreshes, so "ended" acts on the current
  // queue: without this, a track someone else queued mid-song is invisible at the
  // end of playback and the DJ stops instead of advancing to it.
  const latestRef = useRef({ isDJ, detached, loop, onSkip, onSync, roomIsPlaying: !!room?.isPlaying });
  useEffect(() => {
    latestRef.current = { isDJ, detached, loop, onSkip, onSync, roomIsPlaying: !!room?.isPlaying };
  });

  function ensureAudioProcessing(audio) {
    if (!audio || sourceNodeRef.current) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx = audioContextRef.current || new AudioCtx();
      audioContextRef.current = ctx;

      // createMediaElementSource takes the element off the speakers and routes it
      // into this graph — so attaching it to a context that isn't running produces
      // total silence while the element still reports itself as playing. Browsers
      // start a context suspended until the page has been interacted with, which is
      // exactly the state someone is in the moment they join a room. Leave the
      // element on the direct path for now; attachAudioProcessingOnGesture() wires
      // the DSP up as soon as the context can actually run.
      if (ctx.state !== 'running') {
        ctx.resume?.().catch(() => {});
        return;
      }

      const source = ctx.createMediaElementSource(audio);
      // Two-band shelving EQ (bass / treble). Defaults to 0 dB (flat) so the chain is
      // transparent unless an EQ preset is selected (web-only).
      const lowShelf = ctx.createBiquadFilter();
      lowShelf.type = 'lowshelf';
      lowShelf.frequency.value = 200;
      lowShelf.gain.value = 0;
      const highShelf = ctx.createBiquadFilter();
      highShelf.type = 'highshelf';
      highShelf.frequency.value = 3000;
      highShelf.gain.value = 0;

      const compressor = ctx.createDynamicsCompressor();
      const outputGain = ctx.createGain();

      // Gentle loudness smoothing: reduce sudden peaks while keeping tone natural.
      compressor.threshold.value = -22;
      compressor.knee.value = 24;
      compressor.ratio.value = 2.5;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.25;
      outputGain.gain.value = 1.06;

      source.connect(lowShelf);
      lowShelf.connect(highShelf);
      highShelf.connect(compressor);
      compressor.connect(outputGain);
      outputGain.connect(ctx.destination);

      sourceNodeRef.current = source;
      lowShelfRef.current = lowShelf;
      highShelfRef.current = highShelf;
      compressorNodeRef.current = compressor;
      outputGainNodeRef.current = outputGain;
      applyEq(eqMode);
      onDebugEvent?.({ service: 'youtube', lastEvent: 'yt:dsp-enabled' });
    } catch {
      // WebAudio setup can fail in restrictive embeds; fallback to regular element audio.
    }
  }

  // Apply an EQ preset to the shelving filters (smooth ramp avoids clicks).
  function applyEq(mode) {
    const low = lowShelfRef.current;
    const high = highShelfRef.current;
    const ctx = audioContextRef.current;
    if (!low || !high || !ctx) return;
    const preset = EQ_PRESETS[mode] || EQ_PRESETS.flat;
    const t = ctx.currentTime;
    low.gain.setTargetAtTime(preset.bass, t, 0.05);
    high.gain.setTargetAtTime(preset.treble, t, 0.05);
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
        // A play() issued while the element is still buffering (or mid-seek, which
        // is exactly what a joiner syncing to the DJ's position is doing) rejects
        // even when the browser would otherwise allow it. Retry once the element
        // actually has data, so joining doesn't wait for the next DJ sync tick.
        audio.addEventListener(
          'canplay',
          () => {
            audio
              .play()
              .then(() => {
                setNeedsInteraction(false);
                onDebugEvent?.({ service: 'youtube', playerState: 'playing', autoplayBlocked: false, lastEvent: 'yt:play-canplay' });
              })
              .catch(() => {
                // Genuinely gesture-blocked; the Enable audio button stays up.
              });
          },
          { once: true }
        );
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
      const { isDJ: dj, detached: det, onSync: sync } = latestRef.current;
      if (dj || det) {
        sync?.({ position: audio.currentTime || 0, isPlaying: true });
      }
    };
    const onPause = () => {
      onPlayStateChange?.(false);
      onDebugEvent?.({ service: 'youtube', playerState: 'paused', lastEvent: 'yt:pause' });
      const { isDJ: dj, detached: det, onSync: sync } = latestRef.current;
      if (dj || det) {
        sync?.({ position: audio.currentTime || 0, isPlaying: false });
      }
    };
    const onEnded = () => {
      onDebugEvent?.({ service: 'youtube', playerState: 'ended', lastEvent: 'yt:ended' });
      const { isDJ: dj, detached: det, loop: loopMode, onSkip: skip } = latestRef.current;
      if (loopMode === 'track') {
        audio.currentTime = 0;
        audio.play().catch(() => setNeedsInteraction(true));
        return;
      }
      if (dj || det) skip?.();
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

  // Re-apply EQ whenever the selected preset changes (web-only control upstream).
  useEffect(() => {
    applyEq(eqMode);
  }, [eqMode]);

  // An AudioContext can only start once the page has been interacted with, so the
  // EQ/compressor chain can't be attached at load. Watch for the first interaction
  // anywhere — always, not only when playback was visibly blocked — then start the
  // context, attach the DSP, and pick up playback if the room is already playing.
  useEffect(() => {
    const onFirstGesture = () => {
      const audio = audioRef.current;
      const ctx = audioContextRef.current;
      const attach = () => {
        if (audio) ensureAudioProcessing(audio);
      };
      if (ctx?.state === 'suspended') {
        ctx.resume().then(attach).catch(() => {});
      } else {
        attach();
      }
      // A joiner whose autoplay was refused is sitting on a silent player; this is
      // the gesture that lets it start.
      if (audio && audio.paused && latestRef.current.roomIsPlaying) {
        tryPlayWithRecovery();
      }
    };
    window.addEventListener('pointerdown', onFirstGesture, { once: true });
    window.addEventListener('keydown', onFirstGesture, { once: true });
    window.addEventListener('touchstart', onFirstGesture, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onFirstGesture);
      window.removeEventListener('keydown', onFirstGesture);
      window.removeEventListener('touchstart', onFirstGesture);
    };
  }, []);

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
