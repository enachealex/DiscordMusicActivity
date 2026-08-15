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
}) {
  const canControl = isDJ || detached;
  const seekable = canControl && !!currentTrack && duration > 0;
  const remaining = duration > 0 ? Math.max(0, duration - progress) : 0;
  const preVolRef = useRef(volume || 0.7);
  const [showVolumePopup, setShowVolumePopup] = useState(false);
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
    function handleOutsideClick(e) {
      if (!volControlRef.current) return;
      if (!volControlRef.current.contains(e.target)) {
        setShowVolumePopup(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, []);

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

        <div className={`vol-control${showVolumePopup ? ' open' : ''}`} ref={volControlRef}>
          <button
            className="vol-icon-btn"
            onClick={() => setShowVolumePopup((prev) => !prev)}
            aria-label="Adjust volume"
            title="Adjust volume"
          >
            {isMuted ? '🔇' : vol < 0.5 ? '🔉' : '🔊'}
          </button>

          {showVolumePopup && (
            <div className="vol-popup" onClick={(e) => e.stopPropagation()}>
              <div className="vol-readout">{isMuted ? 'Muted' : `${Math.round(vol * 100)}%`}</div>
              <div className="vol-slider-wrap">
                <input
                  type="range"
                  className="vol-slider-vertical"
                  min="0"
                  max="1"
                  step="0.01"
                  value={vol}
                  aria-label="Volume"
                  onChange={(e) => onVolumeChange?.(parseFloat(e.target.value))}
                />
              </div>
              <button
                className="vol-mute-mini"
                onClick={toggleMute}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? 'Unmute' : 'Mute'}
              </button>
              {balanceAvailable && (
                <button
                  className={`vol-balance-btn${balance ? ' active' : ''}`}
                  onClick={onBalanceToggle}
                  aria-pressed={balance}
                  title={
                    balance
                      ? 'Balance on — evens out loud and quiet parts between tracks. Click to turn off.'
                      : 'Balance off — tracks play at their original dynamics. Click to turn on.'
                  }
                >
                  Balance
                </button>
              )}
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
