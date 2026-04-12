export default function ServiceSelector({ current, onChange, isDJ, detached }) {
  const canChange = isDJ || detached;
  return (
    <div className="service-selector">
      <button
        className={`service-btn youtube ${current === 'youtube' ? 'active' : ''}`}
        onClick={() => onChange('youtube')}
        disabled={!canChange}
        title={detached ? 'Switch your local service (detached mode)' : !isDJ ? 'Only the DJ can switch services' : 'Switch to YouTube'}
      >
        ▶ YouTube
      </button>
      <button
        className={`service-btn spotify ${current === 'spotify' ? 'active' : ''}`}
        onClick={() => onChange('spotify')}
        disabled={!canChange}
        title={detached ? 'Switch your local service (detached mode)' : !isDJ ? 'Only the DJ can switch services' : 'Switch to Spotify'}
      >
        ♪ Spotify
      </button>
      {!canChange && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          Only the DJ can switch services
        </span>
      )}
      {detached && (
        <span style={{ fontSize: 12, color: 'var(--accent)', marginLeft: 'auto' }}>
          Local only
        </span>
      )}
    </div>
  );
}