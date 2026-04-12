import { useRef } from 'react';

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
  onPlayToggle,
  onSkip,
  onSeek,
  onVolumeChange,
  currentTrack,
}) {
  const canControl = isDJ || detached;
  const pct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;
  const preVolRef = useRef(volume || 0.7);

  function toggleMute() {
    if (volume < 0.01) {
      onVolumeChange?.(preVolRef.current > 0.01 ? preVolRef.current : 0.7);
    } else {
      preVolRef.current = volume;
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
    <div className="player-bar">
      <div
        className={`progress-track${canControl && currentTrack ? ' seekable' : ''}`}
        onClick={handleProgressClick}
        title={canControl && currentTrack ? 'Click to seek' : ''}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="controls-row">
        <span className="time-label">{currentTrack ? formatTime(progress) : '--:--'}</span>

        <div className="playback-btns">
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
        </div>

        <span className="time-label">{currentTrack && duration > 0 ? formatTime(duration) : '--:--'}</span>

        <div className="vol-control" title={volume < 0.01 ? 'Unmute' : 'Mute'}>
          <button className="vol-icon-btn" onClick={toggleMute} aria-label={volume < 0.01 ? 'Unmute' : 'Mute'}>
            {volume < 0.05 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
          </button>
          <input
            type="range"
            className="vol-slider"
            min="0"
            max="1"
            step="0.02"
            value={volume ?? 0.7}
            onChange={(e) => onVolumeChange?.(parseFloat(e.target.value))}
          />
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
