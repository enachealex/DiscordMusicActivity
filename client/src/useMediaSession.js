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
}) {
  // Handlers are registered once per role change; everything else is read live so
  // the 500ms progress tick never re-registers anything.
  const latestRef = useRef(null);
  latestRef.current = { track, service, isDJ, detached, playerActionsRef, onNext, onSeek, onStop };

  const supported =
    typeof navigator !== 'undefined' && 'mediaSession' in navigator && typeof window.MediaMetadata === 'function';

  // ── Metadata: what the notification shows.
  useEffect(() => {
    if (!supported) return;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    // Thumbnails come through our same-origin proxy, which sets a real
    // Content-Type — remote artwork would be blocked by the spec's fetch rules.
    const artwork = track.thumbnail
      ? [{ src: track.thumbnail, sizes: '320x180', type: 'image/jpeg' }]
      : [];
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: track.title || 'Unknown track',
        artist: track.artist || '',
        album: 'JumpVault Music',
        artwork,
      });
    } catch {
      // Metadata is cosmetic; never let it break playback.
    }
  }, [supported, track?.id, track?.service, track?.title, track?.artist, track?.thumbnail]);

  // ── Playback state: describes THIS device, not the room. A follower who paused
  // locally should see "paused" even while the room plays on.
  useEffect(() => {
    if (!supported) return;
    navigator.mediaSession.playbackState = !track ? 'none' : localPlaying ? 'playing' : 'paused';
  }, [supported, localPlaying, !!track]);

  // ── Position: only where the player can actually report it. SpotifyPlayer
  // returns 0 for both position and duration, and publishing that makes the OS
  // scrubber jump to the start.
  useEffect(() => {
    if (!supported || !track || service === 'spotify') return;
    if (typeof navigator.mediaSession.setPositionState !== 'function') return;
    const actions = playerActionsRef.current;
    const duration = actions.getDuration?.() ?? 0;
    const position = actions.getPosition?.() ?? 0;
    if (!Number.isFinite(duration) || duration <= 0) return; // live streams have none
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(Math.max(position, 0), duration),
        playbackRate: 1,
      });
    } catch {
      // Ignore: a position that briefly disagrees with duration throws.
    }
  }, [supported, track?.id, localPlaying, service]);

  // ── Action handlers.
  useEffect(() => {
    if (!supported) return;
    const canControlRoom = isDJ || detached;

    const set = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Unsupported action on this browser — nothing to do.
      }
    };

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
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, [supported, isDJ, detached]);
}
