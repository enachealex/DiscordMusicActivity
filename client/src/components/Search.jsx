import { useMemo, useState } from 'react';

function thumbSrc(url) {
  if (!url) return '';
  if (url.startsWith('/media/thumb')) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return `/media/thumb?src=${encodeURIComponent(url)}`;
  }
  return url;
}

export default function Search({ service, spotifyToken, spotifyRestoring, queue, onAdd, onSpotifyLogin, onSpotifyLogout }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const queuedIds = useMemo(() => new Set((queue || []).map((track) => track.id)), [queue]);

  // Show Spotify connect prompt when service is Spotify but not authenticated
  if (service === 'spotify' && !spotifyToken) {
    if (spotifyRestoring) {
      return (
        <div className="search-panel spotify-connect-prompt">
          <div className="spotify-connect-icon" style={{ fontSize: 32 }}>⌛</div>
          <p className="spotify-connect-heading">Reconnecting to Spotify…</p>
          <p className="spotify-connect-sub">Restoring your previous session.</p>
        </div>
      );
    }
    return (
      <div className="search-panel spotify-connect-prompt">
        <div className="spotify-connect-icon">🎵</div>
        <p className="spotify-connect-heading">Connect your Spotify account</p>
        <p className="spotify-connect-sub">
          Sign in to search and play music from your Spotify library.
          <br />
          <strong>Spotify Premium is required for playback.</strong>
        </p>
        <button className="btn-spotify" onClick={onSpotifyLogin}>
          Connect Spotify
        </button>
        <p className="spotify-note">Spotify Premium required for in-app playback.</p>
      </div>
    );
  }

  async function handleSearch(e) {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setResults([]);
    setError('');
    try {
      const url =
        service === 'youtube'
          ? `/api/youtube/search?q=${encodeURIComponent(query)}`
          : `/api/spotify/search?q=${encodeURIComponent(query)}&access_token=${encodeURIComponent(spotifyToken)}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error('Search failed');
      setResults(await res.json());
    } catch (err) {
      setError('Search failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleAdd(track) {
    onAdd(track);
  }

  function clearSearch() {
    setQuery('');
    setResults([]);
    setError('');
  }

  return (
    <div className="search-panel">
      <form onSubmit={handleSearch} className="search-input-wrapper">
        <input
          className="search-input"
          placeholder={`Search ${service === 'youtube' ? 'YouTube' : 'Spotify'}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button type="button" className="btn-clear-search" onClick={clearSearch} aria-label="Clear search">
            ×
          </button>
        )}
        <button type="submit" className="btn-search" disabled={loading}>
          {loading ? '…' : 'Search'}
        </button>
      </form>
      <div className="search-session-bar">
        {service === 'youtube' && (
          <span className="session-badge session-badge--ready">● YouTube ready</span>
        )}
        {service === 'spotify' && spotifyToken && (
          <>
            <span className="session-badge session-badge--ready">● Spotify connected</span>
            <button className="btn-disconnect" onClick={onSpotifyLogout}>Disconnect</button>
          </>
        )}
      </div>

      {error && (
        <p style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 6 }}>{error}</p>
      )}

      <div className="search-results">
        {results.map((track) => {
          const isQueued = queuedIds.has(track.id);
          return (
            <div key={track.id} className="search-result-item">
              {track.thumbnail && <img src={thumbSrc(track.thumbnail)} alt="" />}
              <div className="search-result-info">
                <div className="title">{track.title}</div>
                <div className="artist">{track.artist}</div>
              </div>
              <button
                className={`btn-add${isQueued ? ' added' : ''}`}
                onClick={() => handleAdd(track)}
                disabled={isQueued}
              >
                {isQueued ? '✓ Added' : '+ Add'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
