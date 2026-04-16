import { useEffect, useMemo, useRef, useState } from 'react';

function thumbSrc(url) {
  if (!url) return '';
  if (url.startsWith('/media/thumb')) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return `/media/thumb?src=${encodeURIComponent(url)}`;
  }
  return url;
}

export default function Search({ service, spotifyToken, spotifyRestoring, queue, onAdd, onPlayTrack, onLoadPlaylist, onSpotifyLogin, onSpotifyLogout, isDJ }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [activeTab, setActiveTab] = useState('songs');
  const [playlists, setPlaylists] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('discord-music-activity-playlists') || '[]');
    } catch {
      return [];
    }
  });
  const [selectedPlaylistId, setSelectedPlaylistId] = useState(null);
  const [playlistDropdown, setPlaylistDropdown] = useState(null); // { trackId, x, y }
  const [contextMenu, setContextMenu] = useState(null);
  const [showNewPlaylistInput, setShowNewPlaylistInput] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [pendingNewPlaylistTrack, setPendingNewPlaylistTrack] = useState(null);
  const queuedIds = useMemo(() => new Set((queue || []).map((track) => track.id)), [queue]);
  const activePlaylist = playlists.find((playlist) => playlist.id === selectedPlaylistId);
  const playlistCreateHint = pendingNewPlaylistTrack
    ? 'Create a playlist for the selected track.'
    : 'Create a playlist from your current queue.';
  const longPressTimerRef = useRef(null);
  const suppressPlaylistCardClickRef = useRef(false);
  const playlistInputRef = useRef(null);
  const contextMenuRef = useRef(null);
  const playlistDropdownRef = useRef(null);

  useEffect(() => {
    try {
      localStorage.setItem('discord-music-activity-playlists', JSON.stringify(playlists));
    } catch {
      // ignore localStorage failure
    }
  }, [playlists]);

  useEffect(() => {
    function handleClickOutside() {
      if (playlistDropdown || contextMenu) {
        setPlaylistDropdown(null);
        setContextMenu(null);
      }
    }
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [playlistDropdown, contextMenu]);

  useEffect(() => {
    function handleStorage(event) {
      if (event.key !== 'discord-music-activity-playlists') return;
      try {
        setPlaylists(JSON.parse(event.newValue || '[]'));
      } catch {
        // ignore invalid storage values
      }
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    if (showNewPlaylistInput && playlistInputRef.current) {
      playlistInputRef.current.focus();
    }
  }, [showNewPlaylistInput]);

  useEffect(() => {
    function handleCreateRequest(event) {
      openNewPlaylistInput(event.detail?.track || null);
    }

    window.addEventListener('playlist:create-request', handleCreateRequest);
    return () => window.removeEventListener('playlist:create-request', handleCreateRequest);
  }, []);

  function clampMenuPosition(state, ref, setState) {
    if (!state || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const margin = 8;
    let x = state.x;
    let y = state.y;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    if (x > maxX) x = Math.max(margin, maxX);
    if (y > maxY) y = Math.max(margin, maxY);
    if (x < margin) x = margin;
    if (y < margin) y = margin;
    if (x !== state.x || y !== state.y) {
      setState((prev) => (prev ? { ...prev, x, y } : prev));
    }
  }

  useEffect(() => {
    clampMenuPosition(contextMenu, contextMenuRef, setContextMenu);
  }, [contextMenu]);

  useEffect(() => {
    clampMenuPosition(playlistDropdown, playlistDropdownRef, setPlaylistDropdown);
  }, [playlistDropdown]);


  async function handleCopyLoginUrl() {
    if (!onSpotifyLogin) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(onSpotifyLogin);
        setCopyStatus('Copied');
        return;
      }
    } catch {
      // Fall back to legacy copy path below when clipboard permissions are blocked.
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = onSpotifyLogin;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopyStatus(ok ? 'Copied' : 'Copy blocked; select the link and press Ctrl+C');
    } catch {
      setCopyStatus('Copy blocked; select the link and press Ctrl+C');
    }
  }

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
        {typeof onSpotifyLogin === 'string' && onSpotifyLogin ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
            <a
              href={onSpotifyLogin}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-spotify"
              style={{ display: 'inline-block', textAlign: 'center', textDecoration: 'none' }}
            >
              Click Here to Sign In
            </a>
            <p style={{ margin: '5px 0 0', fontSize: '11px', color: 'var(--text-sub)', textAlign: 'center' }}>
              Or copy this link and paste it into your device's web browser:
            </p>
            <div style={{ display: 'flex', gap: '6px', width: '100%', maxWidth: '400px' }}>
              <input
                readOnly
                value={onSpotifyLogin}
                style={{ 
                  flex: 1, padding: '4px 6px', fontSize: '10px', borderRadius: '4px', 
                  border: '1px solid var(--border)', background: 'rgba(0, 0, 0, 0.5)', 
                  color: 'white', outline: 'none' 
                }}
                onClick={(e) => e.target.select()}
              />
              <button
                style={{ 
                  padding: '4px 12px', fontSize: '11px', cursor: 'pointer', 
                  borderRadius: '4px', background: 'white', color: 'black', 
                  border: 'none', fontWeight: 'bold' 
                }}
                onClick={handleCopyLoginUrl}
              >
                Copy
              </button>
            </div>
            {copyStatus ? (
              <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--text-sub)' }}>{copyStatus}</p>
            ) : null}
          </div>
        ) : (
          <button className="btn-spotify" disabled>
            Loading...
          </button>
        )}
        <p className="spotify-note">Spotify Premium required for in-app playback.</p>
      </div>
    );
  }

  function openNewPlaylistInput(track = null) {
    setActiveTab('playlist');
    setPendingNewPlaylistTrack(track);
    setShowNewPlaylistInput(true);
    setNewPlaylistName('');
    setPlaylistDropdown(null);
    setContextMenu(null);
    setSelectedPlaylistId(null);
  }

  function submitNewPlaylist() {
    const name = newPlaylistName.trim();
    if (!name) return;
    const id = `pl-${Date.now()}`;
    const newPlaylist = {
      id,
      name,
      tracks: pendingNewPlaylistTrack
        ? [{ ...pendingNewPlaylistTrack }]
        : queue.map((track) => ({ ...track })),
    };
    setPlaylists((prev) => [...prev, newPlaylist]);
    setSelectedPlaylistId(id);
    setActiveTab('playlist');
    setShowNewPlaylistInput(false);
    setNewPlaylistName('');
    setPendingNewPlaylistTrack(null);
  }

  function cancelNewPlaylist() {
    setShowNewPlaylistInput(false);
    setNewPlaylistName('');
    setPendingNewPlaylistTrack(null);
  }

  function selectPlaylist(id) {
    setSelectedPlaylistId(id);
  }

  function clearSelectedPlaylist() {
    setSelectedPlaylistId(null);
  }

  function handlePlaylistCardContextMenu(e, playlist) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      type: 'playlist',
      playlist,
    });
  }

  function handlePlaylistCardTap(playlistId) {
    if (suppressPlaylistCardClickRef.current) {
      suppressPlaylistCardClickRef.current = false;
      return;
    }
    selectPlaylist(playlistId);
  }

  function handlePlaylistCardTouchStart(e, playlist) {
    const timer = setTimeout(() => {
      const touch = e.touches?.[0];
      suppressPlaylistCardClickRef.current = true;
      setContextMenu({
        x: touch?.clientX || 0,
        y: (touch?.clientY || 0) + 20,
        type: 'playlist',
        playlist,
      });
    }, 500);
    longPressTimerRef.current = timer;
  }

  function clearPlaylistCardLongPress() {
    clearTimeout(longPressTimerRef.current);
  }

  function handlePlaylistSongContextMenu(e, songIndex) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      type: 'song',
      songIndex,
    });
  }

  function openPlaylistDropdown(e, track) {
    e.stopPropagation();
    const rect = e.target.getBoundingClientRect();
    setPlaylistDropdown({
      track,
      x: rect.left,
      y: rect.bottom + 4,
    });
  }

  function closeContextMenu() {
    setContextMenu(null);
    setPlaylistDropdown(null);
  }

  function playSelectedPlaylist() {
    const playlistToPlay = contextMenu?.type === 'playlist' ? contextMenu.playlist : activePlaylist;
    if (!playlistToPlay) return;
    onLoadPlaylist(playlistToPlay.tracks);
    closeContextMenu();
  }

  function deleteSelectedPlaylist() {
    if (contextMenu?.type !== 'playlist' || !contextMenu.playlist) return;
    const playlistId = contextMenu.playlist.id;
    setPlaylists((prev) => prev.filter((playlist) => playlist.id !== playlistId));
    setSelectedPlaylistId((prev) => (prev === playlistId ? null : prev));
    closeContextMenu();
  }

  function addSelectedPlaylistTrackToQueue(track) {
    onAdd(track);
    closeContextMenu();
  }

  function playSelectedPlaylistTrack(track) {
    onPlayTrack(track);
    closeContextMenu();
  }

  function deleteSongFromPlaylist(songIndex) {
    if (!activePlaylist) return;
    const updatedTracks = activePlaylist.tracks.filter((_, index) => index !== songIndex);
    setPlaylists((prev) =>
      prev.map((playlist) =>
        playlist.id === selectedPlaylistId
          ? { ...playlist, tracks: updatedTracks }
          : playlist
      )
    );
    closeContextMenu();
  }

  function addSongToPlaylist(track, playlistId) {
    setPlaylists((prev) =>
      prev.map((playlist) =>
        playlist.id === playlistId
          ? { ...playlist, tracks: [...playlist.tracks, track] }
          : playlist
      )
    );
  }

  function createPlaylistFromSong(track) {
    openNewPlaylistInput(track);
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

        <div className="search-action-bar">
          <button
            type="button"
            className={`btn-tab${activeTab === 'songs' ? ' active' : ''}`}
            onClick={() => {
              setActiveTab('songs');
              setSelectedPlaylistId(null);
              closeContextMenu();
            }}
          >
            Songs
          </button>
          <button
            type="button"
            className={`btn-tab${activeTab === 'playlist' ? ' active' : ''}`}
            onClick={() => {
              setActiveTab('playlist');
              setSelectedPlaylistId(null);
              closeContextMenu();
            }}
          >
            Playlist
          </button>
        </div>
      </form>

      {error && (
        <p style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 6 }}>{error}</p>
      )}

      {activeTab === 'playlist' ? (
        <div className="playlist-manager">
          <div className="playlist-manager-header">
            <div>
              <div className="playlist-manager-title">Playlists</div>
              <div className="playlist-manager-description">Create playlists, view songs, and add search results or queued tracks.</div>
            </div>
            <div className="playlist-creation-row">
              <button type="button" className="btn-new-playlist" onClick={() => openNewPlaylistInput(null)}>
                + New Playlist
              </button>
              {showNewPlaylistInput && (
                <div className="new-playlist-entry">
                  <input
                    ref={playlistInputRef}
                    className="new-playlist-input"
                    value={newPlaylistName}
                    onChange={(e) => setNewPlaylistName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        submitNewPlaylist();
                      }
                      if (e.key === 'Escape') {
                        cancelNewPlaylist();
                      }
                    }}
                    placeholder="Playlist name"
                  />
                  <button type="button" className="btn-new-playlist-create" onClick={submitNewPlaylist}>
                    Create
                  </button>
                  <button type="button" className="btn-back-playlist" onClick={cancelNewPlaylist}>
                    Cancel
                  </button>
                  <div className="playlist-input-hint">{playlistCreateHint}</div>
                </div>
              )}
            </div>
            {activePlaylist ? (
              <button type="button" className="btn-back-playlist" onClick={clearSelectedPlaylist}>
                ← Back to playlists
              </button>
            ) : null}
          </div>

          {activePlaylist ? (
            <div className="playlist-songs">
              {activePlaylist.tracks.length > 0 ? (
                activePlaylist.tracks.map((track, index) => (
                  <div
                    key={`${track.id}-${index}`}
                    className="playlist-song-item"
                    onContextMenu={(e) => handlePlaylistSongContextMenu(e, index)}
                    onTouchStart={(e) => {
                      const timer = setTimeout(() => {
                        const touch = e.touches?.[0];
                        setContextMenu({ x: touch?.clientX || 0, y: (touch?.clientY || 0) + 20, type: 'song', songIndex: index });
                      }, 500);
                      longPressTimerRef.current = timer;
                    }}
                    onTouchEnd={() => clearTimeout(longPressTimerRef.current)}
                    onTouchMove={() => clearTimeout(longPressTimerRef.current)}
                  >
                    {track.thumbnail && <img src={thumbSrc(track.thumbnail)} alt="" />}
                    <div className="playlist-item-info">
                      <div className="title">{track.title}</div>
                      <div className="artist">{track.artist}</div>
                    </div>
                    <span className="playlist-item-badge">#{index + 1}</span>
                  </div>
                ))
              ) : (
                <div className="queue-empty">This playlist is empty.</div>
              )}
            </div>
          ) : (
            <div className="playlist-list">
              {playlists.length > 0 ? (
                playlists.map((playlist) => (
                  <div
                    key={playlist.id}
                    className="playlist-card"
                    onClick={() => handlePlaylistCardTap(playlist.id)}
                    onContextMenu={(e) => handlePlaylistCardContextMenu(e, playlist)}
                    onTouchStart={(e) => handlePlaylistCardTouchStart(e, playlist)}
                    onTouchEnd={clearPlaylistCardLongPress}
                    onTouchMove={clearPlaylistCardLongPress}
                    onTouchCancel={clearPlaylistCardLongPress}
                  >
                    <div>
                      <div className="playlist-card-title">{playlist.name}</div>
                      <div className="playlist-card-meta">{playlist.tracks.length} song{playlist.tracks.length !== 1 ? 's' : ''}</div>
                    </div>
                    <div className="playlist-card-arrow">›</div>
                  </div>
                ))
              ) : (
                <div className="queue-empty">No playlists yet. Create one to get started.</div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="search-results">
          {results.map((track) => {
            const isQueued = queuedIds.has(track.id);
            return (
              <div key={track.id} className="search-result-item"
                onTouchStart={(e) => {
                  const timer = setTimeout(() => {
                    const touch = e.touches?.[0];
                    setPlaylistDropdown({ track, x: touch?.clientX || 0, y: (touch?.clientY || 0) + 20 });
                  }, 500);
                  longPressTimerRef.current = timer;
                }}
                onTouchEnd={() => clearTimeout(longPressTimerRef.current)}
                onTouchMove={() => clearTimeout(longPressTimerRef.current)}
              >
                {track.thumbnail && <img src={thumbSrc(track.thumbnail)} alt="" />}
                <div className="search-result-info">
                  <div className="title">{track.title}</div>
                  <div className="artist">{track.artist}</div>
                </div>
                <div className="search-result-actions">
                  <button
                    className={`btn-add${isQueued ? ' added' : ''}`}
                    onClick={() => handleAdd(track)}
                    disabled={isQueued}
                  >
                    {isQueued ? '✓ Added' : '+ Queue'}
                  </button>
                  <div className="playlist-dropdown">
                    <button
                      className="btn-add-playlist"
                      onClick={(e) => {
                        if (playlists.length === 0) {
                          createPlaylistFromSong(track);
                        } else {
                          openPlaylistDropdown(e, track);
                        }
                      }}
                    >
                      + Playlist
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {playlistDropdown && (
        <div
          ref={playlistDropdownRef}
          className="playlist-dropdown-menu"
          style={{ top: playlistDropdown.y, left: playlistDropdown.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="playlist-dropdown-header">Add to Playlist</div>
          {playlists.map((playlist) => (
            <button
              key={playlist.id}
              className="playlist-dropdown-item"
              onClick={() => {
                addSongToPlaylist(playlistDropdown.track, playlist.id);
                setPlaylistDropdown(null);
              }}
            >
              {playlist.name}
            </button>
          ))}
          <div className="playlist-dropdown-divider"></div>
          <button
            className="playlist-dropdown-item"
            onClick={() => {
              createPlaylistFromSong(playlistDropdown.track);
              setPlaylistDropdown(null);
            }}
          >
            + New Playlist
          </button>
        </div>
      )}

      {contextMenu && (contextMenu.type === 'playlist' || (contextMenu.type === 'song' && activePlaylist)) && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'playlist' ? (
            <>
              {isDJ && (
                <button
                  onClick={() => {
                    playSelectedPlaylist();
                  }}
                >
                  ▶ Play Now
                </button>
              )}
              <button
                onClick={() => {
                  deleteSelectedPlaylist();
                }}
              >
                🗑 Delete Playlist
              </button>
            </>
          ) : null}
          {contextMenu.type === 'song' && activePlaylist ? (
            <>
              <button
                onClick={() => {
                  addSelectedPlaylistTrackToQueue(activePlaylist.tracks[contextMenu.songIndex]);
                }}
              >
                + Add to Queue
              </button>
              {isDJ && (
                <button
                  onClick={() => {
                    playSelectedPlaylistTrack(activePlaylist.tracks[contextMenu.songIndex]);
                  }}
                >
                  ▶ Play Now
                </button>
              )}
              <button
                onClick={() => {
                  deleteSongFromPlaylist(contextMenu.songIndex);
                }}
              >
                🗑 Delete from Playlist
              </button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
