import { useEffect, useRef } from 'react';

// Publishes what's playing to the OS: lock-screen and notification controls on
// mobile, the media keys on desktop, and the media hub on Android/Windows.
//
// Two things worth knowing before changing this:
//
// 1. Android WebView has no Media Session API at all — navigator.mediaSession is
//    undefined inside the packaged app, so every access must be guarded or the
//    APK throws on first render. The APK needs a native plugin instead; this hook
//    covers browsers and the iOS home-screen app.
// 2. A follower's audio is driven by the room. If they pause from the lock screen,
//    the follower-sync effect would resume it within five seconds. That's why
//    pausing as a follower sets a local gate (setFollowerPaused) rather than just
//    calling pause.
// The packaged Android app has no navigator.mediaSession, but it does have a native
// plugin with the same shape. This adapter hides which one is in play.
//
// One hard rule on the native side: telling it "playing" while the page is hidden
// starts a foreground service from the background and crashes the app. Anything sent
// while hidden is therefore queued and flushed when the page is visible again.
function getNativeSession() {
  const plugin = typeof window !== 'undefined' && window.Capacitor?.Plugins?.MediaSession;
  if (!plugin) return null;
  let queuedState = null;

  const flush = () => {
    if (queuedState && document.visibilityState === 'visible') {
      const state = queuedState;
      queuedState = null;
      plugin.setPlaybackState({ playbackState: state }).catch(() => {});
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', flush);
  }

  return {
    kind: 'native',
    setMetadata: (meta) => plugin.setMetadata(meta).catch(() => {}),
    setPlaybackState: (state) => {
      if (state === 'playing' && document.visibilityState !== 'visible') {
        queuedState = state;
        return;
      }
      queuedState = null;
      plugin.setPlaybackState({ playbackState: state }).catch(() => {});
    },
    setActionHandler: (action, handler) =>
      plugin.setActionHandler({ action }, handler).catch(() => {}),
    setPositionState: (position) => plugin.setPositionState(position).catch(() => {}),
  };
}

function getWebSession() {
  const supported =
    typeof navigator !== 'undefined' &&
    'mediaSession' in navigator &&
    typeof window.MediaMetadata === 'function';
  if (!supported) return null;
  return {
    kind: 'web',
    setMetadata: (meta) => {
      try {
        navigator.mediaSession.metadata = meta ? new window.MediaMetadata(meta) : null;
      } catch {
        // Metadata is cosmetic; never let it break playback.
      }
    },
    setPlaybackState: (state) => {
      navigator.mediaSession.playbackState = state;
    },
    setActionHandler: (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Unsupported action on this browser.
      }
    },
    setPositionState: (position) => {
      if (typeof navigator.mediaSession.setPositionState !== 'function') return;
      try {
        navigator.mediaSession.setPositionState(position);
      } catch {
        // A position that briefly disagrees with duration throws.
      }
    },
  };
}

export function useMediaSession({
  track,
  service,
  localPlaying,
  isDJ,
  detached,
  playerActionsRef,
  onNext,
  onSeek,
  onStop,
  // Native only: the OS media session runs a foreground service with a persistent
  // notification, so it stays off until the listener asks for it.
  nativeEnabled = false,
}) {
  // Handlers are registered once per role change; everything else is read live so
  // the 500ms progress tick never re-registers anything.
  const latestRef = useRef(null);
  latestRef.current = { track, service, isDJ, detached, playerActionsRef, onNext, onSeek, onStop };

  // Built once. Native wins where present, but only once the listener has opted in.
  const sessionRef = useRef(undefined);
  if (sessionRef.current === undefined) sessionRef.current = { native: getNativeSession(), web: getWebSession() };
  const session = sessionRef.current.native
    ? (nativeEnabled ? sessionRef.current.native : null)
    : sessionRef.current.web;
  const supported = !!session;

  // ── Metadata: what the notification shows.
  useEffect(() => {
    if (!supported) return;
    if (!track) {
      session.setMetadata(null);
      return;
    }
    // Thumbnails come through our same-origin proxy, which sets a real
    // Content-Type — remote artwork would be blocked by the spec's fetch rules.
    // Native needs an absolute URL; the browser is happy with either.
    const artworkSrc = track.thumbnail
      ? new URL(track.thumbnail, window.location.origin).toString()
      : null;
    session.setMetadata({
      title: track.title || 'Unknown track',
      artist: track.artist || '',
      album: 'JumpVault Music',
      artwork: artworkSrc ? [{ src: artworkSrc, sizes: '320x180', type: 'image/jpeg' }] : [],
    });
  }, [supported, session, track?.id, track?.service, track?.title, track?.artist, track?.thumbnail]);

  // ── Playback state: describes THIS device, not the room. A follower who paused
  // locally should see "paused" even while the room plays on.
  useEffect(() => {
    if (!supported) return;
    session.setPlaybackState(!track ? 'none' : localPlaying ? 'playing' : 'paused');
  }, [supported, session, localPlaying, !!track]);

  // ── Position: only where the player can actually report it. SpotifyPlayer
  // returns 0 for both position and duration, and publishing that makes the OS
  // scrubber jump to the start.
  useEffect(() => {
    if (!supported || !track || service === 'spotify') return;
    const actions = playerActionsRef.current;
    const duration = actions.getDuration?.() ?? 0;
    const position = actions.getPosition?.() ?? 0;
    if (!Number.isFinite(duration) || duration <= 0) return; // live streams have none
    session.setPositionState({
      duration,
      position: Math.min(Math.max(position, 0), duration),
      playbackRate: 1,
    });
  }, [supported, session, track?.id, localPlaying, service]);

  // ── Action handlers.
  useEffect(() => {
    if (!supported) return;
    const canControlRoom = isDJ || detached;

    const set = (action, handler) => session.setActionHandler(action, handler);

    set('play', () => {
      const { playerActionsRef: ref } = latestRef.current;
      ref.current.setFollowerPaused?.(false);
      ref.current.play?.();
    });

    set('pause', () => {
      const { playerActionsRef: ref, isDJ: dj, detached: det } = latestRef.current;
      // A follower pausing must also gate the room-driven resume, or the next
      // sync tick starts the audio again a few seconds later.
      if (!dj && !det) ref.current.setFollowerPaused?.(true);
      ref.current.pause?.();
    });

    set('stop', () => {
      const { isDJ: dj, detached: det, onStop: stop, playerActionsRef: ref } = latestRef.current;
      if (dj || det) stop?.();
      else {
        ref.current.setFollowerPaused?.(true);
        ref.current.pause?.();
      }
    });

    // Only whoever controls playback gets transport beyond play/pause; a
    // follower skipping would yank the track for everyone.
    set('nexttrack', canControlRoom ? () => latestRef.current.onNext?.() : null);
    set('seekto', canControlRoom ? (details) => {
      if (typeof details?.seekTime === 'number') latestRef.current.onSeek?.(details.seekTime);
    } : null);
    set('seekforward', canControlRoom ? (details) => {
      const ref = latestRef.current.playerActionsRef.current;
      latestRef.current.onSeek?.((ref.getPosition?.() ?? 0) + (details?.seekOffset ?? 10));
    } : null);
    set('seekbackward', canControlRoom ? (details) => {
      const ref = latestRef.current.playerActionsRef.current;
      latestRef.current.onSeek?.(Math.max(0, (ref.getPosition?.() ?? 0) - (details?.seekOffset ?? 10)));
    } : null);

    return () => {
      for (const action of ['play', 'pause', 'stop', 'nexttrack', 'seekto', 'seekforward', 'seekbackward']) {
        session.setActionHandler(action, null);
      }
    };
  }, [supported, session, isDJ, detached]);
}
