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
}) {
  const canControl = isDJ || detached;
  const pct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;
  const remaining = duration > 0 ? Math.max(0, duration - progress) : 0;
  const preVolRef = useRef(volume || 0.7);
  const [showVolumePopup, setShowVolumePopup] = useState(false);
  const volControlRef = useRef(null);
  const vol = Number.isFinite(volume) ? volume : 0.7;
  // Muted means silent, not merely quiet. The slider steps in 0.02, so treating
  // anything under 5% as muted made audible volumes show the muted icon.
  const isMuted = vol <= 0;

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

  function handleProgressClick(e) {
    if (!canControl || !currentTrack || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek?.(ratio * duration);
  }

  return (
    <div className={`player-bar${expanded ? ' expanded' : ''}`}>
      <div
        className={`progress-track${canControl && currentTrack ? ' seekable' : ''}`}
        onClick={handleProgressClick}
        title={canControl && currentTrack ? 'Click to seek' : ''}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
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
              <div className="vol-slider-wrap">
                <input
                  type="range"
                  className="vol-slider-vertical"
                  min="0"
                  max="1"
                  step="0.02"
                  value={vol}
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
