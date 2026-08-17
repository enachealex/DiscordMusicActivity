import { useEffect, useRef, useState } from 'react';

function formatTime(secs) {
  const s = Math.floor(secs || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function PlayerControls({
  isPlaying,
  progress,
  duration,
  isDJ,
  detached,
  volume,
  expanded,
  shuffle,
  loop,
  onShuffleToggle,
  onLoopToggle,
  onPlayToggle,
  onSkip,
  onSeek,
  onVolumeChange,
  currentTrack,
  balance = true,
  onBalanceToggle,
  balanceAvailable = true,
  backgroundEnabled = false,
  onBackgroundToggle,
  backgroundAvailable = false,
}) {
  const canControl = isDJ || detached;
  const seekable = canControl && !!currentTrack && duration > 0;
  const remaining = duration > 0 ? Math.max(0, duration - progress) : 0;
  const preVolRef = useRef(volume || 0.7);
  const [showVolumePopup, setShowVolumePopup] = useState(false);
  // Audio options (Mute / Balance) live in their own dropdown off the caret, so the
  // slider popup stays a narrow column instead of a cramped stack of controls.
  const [showVolumeMenu, setShowVolumeMenu] = useState(false);
  // Windows-style level badge: shows while the slider is being moved (or held) and
  // fades shortly after, so a quick nudge still tells you where you landed.
  const [showVolumeBadge, setShowVolumeBadge] = useState(false);
  const badgeTimerRef = useRef(null);
  const volControlRef = useRef(null);
  const trackRef = useRef(null);
  // Position being dragged to, 0–1. Null when the thumb isn't being held.
  const [dragRatio, setDragRatio] = useState(null);
  // Where a just-released drag asked to go. `progress` only refreshes twice a
  // second, so without this the thumb snaps back to the old spot for a moment.
  const [pendingRatio, setPendingRatio] = useState(null);
  const vol = Number.isFinite(volume) ? volume : 0.7;
  // Muted means silent, not merely quiet. The slider steps in 0.02, so treating
  // anything under 5% as muted made audible volumes show the muted icon.
  const isMuted = vol <= 0;

  const livePct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;
  const activeRatio = dragRatio ?? pendingRatio;
  const pct = activeRatio !== null ? activeRatio * 100 : livePct;
  const scrubSeconds = activeRatio !== null ? activeRatio * duration : progress;

  // Hand control back to the live position once playback has caught up with the
  // seek (or shortly after, if it never reports arriving).
  useEffect(() => {
    if (pendingRatio === null) return;
    if (Math.abs(progress - pendingRatio * duration) < 1.5) {
      setPendingRatio(null);
      return;
    }
    const timer = setTimeout(() => setPendingRatio(null), 1500);
    return () => clearTimeout(timer);
  }, [pendingRatio, progress, duration]);

  useEffect(() => {
    function closeAll() {
      setShowVolumePopup(false);
      setShowVolumeMenu(false);
    }
    function handleOutsideClick(e) {
      if (!volControlRef.current) return;
      if (!volControlRef.current.contains(e.target)) closeAll();
    }
    function handleEscape(e) {
      if (e.key === 'Escape') closeAll();
    }
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const VOLUME_BADGE_LINGER_MS = 1200;

  // Keep the badge up while the slider is in use, and for a moment afterwards.
  function flashVolumeBadge() {
    setShowVolumeBadge(true);
    clearTimeout(badgeTimerRef.current);
    badgeTimerRef.current = setTimeout(() => setShowVolumeBadge(false), VOLUME_BADGE_LINGER_MS);
  }

  useEffect(() => () => clearTimeout(badgeTimerRef.current), []);

  function toggleMute() {
    if (isMuted) {
      onVolumeChange?.(preVolRef.current > 0 ? preVolRef.current : 0.7);
    } else {
      preVolRef.current = vol;
      onVolumeChange?.(0);
    }
  }

  function ratioFromPointer(e) {
    const rect = trackRef.current.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  // Pointer events cover mouse, touch and pen with one path. Capturing the pointer
  // keeps the drag alive when the finger slides off the bar, which on a 6px-tall
  // track is most of the time.
  function handlePointerDown(e) {
    if (!seekable) return;
    e.preventDefault();
    try {
      trackRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is an optimisation; the drag still tracks without it.
    }
    setDragRatio(ratioFromPointer(e));
  }

  function handlePointerMove(e) {
    if (dragRatio === null) return;
    setDragRatio(ratioFromPointer(e));
  }

  function handlePointerUp(e) {
    if (dragRatio === null) return;
    const ratio = ratioFromPointer(e);
    try {
      trackRef.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      // Already released (e.g. pointercancel) — nothing to undo.
    }
    setDragRatio(null);
    setPendingRatio(ratio);
    onSeek?.(ratio * duration);
  }

  // A tap is a zero-distance drag, so click-to-seek still works via the same path.
  function handleTrackKeyDown(e) {
    if (!seekable) return;
    const step = e.shiftKey ? 30 : 5;
    let target = null;
    if (e.key === 'ArrowRight') target = Math.min(duration, progress + step);
    else if (e.key === 'ArrowLeft') target = Math.max(0, progress - step);
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = duration;
    if (target === null) return;
    e.preventDefault();
    setPendingRatio(duration > 0 ? target / duration : 0);
    onSeek?.(target);
  }

  return (
    <div className={`player-bar${expanded ? ' expanded' : ''}`}>
      <div
        ref={trackRef}
        className={`progress-track${seekable ? ' seekable' : ''}${dragRatio !== null ? ' dragging' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleTrackKeyDown}
        title={seekable ? 'Drag to seek' : ''}
        role={seekable ? 'slider' : undefined}
        tabIndex={seekable ? 0 : undefined}
        aria-label={seekable ? 'Playback position' : undefined}
        aria-valuemin={seekable ? 0 : undefined}
        aria-valuemax={seekable ? Math.floor(duration) : undefined}
        aria-valuenow={seekable ? Math.floor(scrubSeconds) : undefined}
        aria-valuetext={seekable ? formatTime(scrubSeconds) : undefined}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
        {seekable && <div className="progress-thumb" style={{ left: `${pct}%` }} />}
        {dragRatio !== null && (
          <div className="progress-tooltip" style={{ left: `${pct}%` }}>
            {formatTime(scrubSeconds)}
          </div>
        )}
      </div>

      <div className="controls-row">
        <div className="playback-btns">
          <button
            className={`ctrl-btn ctrl-btn--sm${shuffle ? ' active' : ''}`}
            onClick={onShuffleToggle}
            title={shuffle ? 'Shuffle on — click to disable' : 'Shuffle off — click to enable'}
          >
            ⇌
          </button>
          <button
            className="ctrl-btn ctrl-btn--sm"
            onClick={() => onSeek?.(Math.max(0, progress - 15))}
            disabled={!canControl || !currentTrack}
            title="Rewind 15 seconds"
          >
            ↩15
          </button>
          <button
            className="ctrl-btn"
            onClick={onPlayToggle}
            disabled={!canControl || !currentTrack}
            title={canControl ? (isPlaying ? 'Pause' : 'Play') : 'Only the DJ controls playback'}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button
            className="ctrl-btn"
            onClick={onSkip}
            disabled={!canControl || !currentTrack}
            title={canControl ? 'Skip to next track' : 'Only the DJ can skip'}
          >
            ⏭
          </button>
          <button
            className={`ctrl-btn ctrl-btn--sm${loop !== 'off' ? ' active' : ''}`}
            onClick={onLoopToggle}
            title={loop === 'off' ? 'Loop off — click for loop track' : loop === 'track' ? 'Loop track — click for loop queue' : 'Loop queue — click to disable'}
          >
            {loop === 'track' ? '↻¹' : '↻'}
          </button>
        </div>

        <span className="time-label">{currentTrack && duration > 0 ? `-${formatTime(remaining)}` : '--:--'}</span>

        <div className={`vol-control${showVolumePopup || showVolumeMenu ? ' open' : ''}`} ref={volControlRef}>
          {/* One bordered group with a divider, so the speaker and the caret read as
              two halves of the same control rather than two loose icons. */}
          <div className="vol-btn-group">
          <button
            className={`vol-icon-btn${showVolumePopup ? ' open' : ''}`}
            onClick={() => {
              setShowVolumeMenu(false);
              setShowVolumePopup((prev) => !prev);
            }}
            aria-label="Adjust volume"
            title="Adjust volume"
          >
            {isMuted ? '🔇' : vol < 0.5 ? '🔉' : '🔊'}
          </button>

          <button
            className={`vol-caret-btn${showVolumeMenu ? ' open' : ''}`}
            onClick={() => {
              setShowVolumePopup(false);
              setShowVolumeMenu((prev) => !prev);
            }}
            aria-label="Audio options"
            aria-haspopup="menu"
            aria-expanded={showVolumeMenu}
            title="Audio options"
          >
            {/* Drawn rather than the ▾ glyph, which rendered as a few near-invisible
                pixels at this size. */}
            <svg viewBox="0 0 12 8" width="12" height="8" aria-hidden="true">
              <path
                d="M1.5 2 L6 6.5 L10.5 2"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          </div>

          {showVolumeMenu && (
            <div className="vol-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              <button
                className="vol-menu-item"
                role="menuitem"
                onClick={() => {
                  toggleMute();
                  setShowVolumeMenu(false);
                }}
              >
                {isMuted ? 'Unmute' : 'Mute'}
              </button>
              {balanceAvailable && (
                <button
                  className={`vol-menu-item vol-menu-toggle${balance ? ' active' : ''}`}
                  role="menuitemcheckbox"
                  aria-checked={balance}
                  onClick={onBalanceToggle}
                  title={
                    balance
                      ? 'Balance on — evens out loud and quiet parts between tracks. Click to turn off.'
                      : 'Balance off — tracks play at their original dynamics. Click to turn on.'
                  }
                >
                  Balance
                </button>
              )}
              {backgroundAvailable && (
                <button
                  className={`vol-menu-item vol-menu-toggle${backgroundEnabled ? ' active' : ''}`}
                  role="menuitemcheckbox"
                  aria-checked={backgroundEnabled}
                  onClick={onBackgroundToggle}
                  title={
                    backgroundEnabled
                      ? 'Background on — playback continues outside the app, with controls in the notification shade. Click to turn off.'
                      : 'Background off — no media notification. Click to turn on.'
                  }
                >
                  Background
                </button>
              )}
            </div>
          )}

          {showVolumePopup && (
            <div className="vol-popup" onClick={(e) => e.stopPropagation()}>
              <div className="vol-slider-wrap">
                {showVolumeBadge && (
                  <div
                    className="vol-badge"
                    // Rides alongside the thumb: 0 sits at the bottom of the travel.
                    style={{ top: `${(1 - vol) * 100}%` }}
                  >
                    {Math.round(vol * 100)}
                  </div>
                )}
                <input
                  type="range"
                  className="vol-slider-vertical"
                  min="0"
                  max="1"
                  step="0.01"
                  value={vol}
                  aria-label="Volume"
                  // Press-and-hold shows the level even before it changes.
                  onPointerDown={flashVolumeBadge}
                  onKeyDown={flashVolumeBadge}
                  onChange={(e) => {
                    flashVolumeBadge();
                    onVolumeChange?.(parseFloat(e.target.value));
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {!isDJ && !detached && currentTrack && (
        <div className="sync-pill">🔵 Synced to DJ</div>
      )}
      {detached && currentTrack && (
        <div className="sync-pill">🎧 Personal mode</div>
      )}
    </div>
  );
}
