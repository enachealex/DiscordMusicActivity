import { useEffect, useRef, useState } from 'react';

function thumbSrc(url) {
  if (!url) return '';
  if (url.startsWith('/media/thumb')) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return `/media/thumb?src=${encodeURIComponent(url)}`;
  }
  return url;
}

export default function Queue({ queue, currentIndex, isDJ, onRemove, onPlayNow, onReorder }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, index }
  const [playlistDropdown, setPlaylistDropdown] = useState(null); // { x, y, index }
  const [playlists, setPlaylists] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('discord-music-activity-playlists') || '[]');
    } catch {
      return [];
    }
  });
  const pointerDownRef = useRef(null);
  const draggedRef = useRef(false);
  const longPressTimerRef = useRef(null);
  const contextMenuRef = useRef(null);
  const playlistDropdownRef = useRef(null);

  function handleContextMenu(e, index) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, index });
    setPlaylistDropdown(null);
  }

  function closeMenu() {
    setContextMenu(null);
    setPlaylistDropdown(null);
  }

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

  useEffect(() => {
    function handleClickOutside() {
      if (contextMenu || playlistDropdown) {
        setContextMenu(null);
        setPlaylistDropdown(null);
      }
    }
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [contextMenu, playlistDropdown]);

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

  function handleDragStart(e, index) {
    draggedRef.current = true;
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e, index) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (index !== dropIndex) setDropIndex(index);
  }

  function handleDrop(e, index) {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== index) {
      onReorder(dragIndex, index);
    }
    setDragIndex(null);
    setDropIndex(null);
  }

  function handleDragEnd() {
    window.setTimeout(() => {
      draggedRef.current = false;
    }, 0);
    setDragIndex(null);
    setDropIndex(null);
  }

  function openPlaylistDropdown(e, index) {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu(null);
    setPlaylistDropdown({ x: rect.left, y: rect.bottom + 4, index });
  }

  function persistPlaylists(nextPlaylists) {
    try {
      localStorage.setItem('discord-music-activity-playlists', JSON.stringify(nextPlaylists));
      setPlaylists(nextPlaylists);
    } catch {
      // ignore localStorage failure
    }
  }

  function addTrackToPlaylist(track, playlistId) {
    const nextPlaylists = playlists.map((playlist) =>
      playlist.id === playlistId
        ? { ...playlist, tracks: [...playlist.tracks, track] }
        : playlist
    );
    persistPlaylists(nextPlaylists);
    setPlaylistDropdown(null);
    setContextMenu(null);
  }

  function requestPlaylistCreation(track) {
    window.dispatchEvent(new CustomEvent('playlist:create-request', { detail: { track } }));
    setPlaylistDropdown(null);
    setContextMenu(null);
  }

  function handleMouseDown(e, index) {
    if (e.button !== 0) return;
    pointerDownRef.current = {
      index,
      x: e.clientX,
      y: e.clientY,
      moved: false,
    };
  }

  function handleMouseMove(e) {
    if (!pointerDownRef.current) return;
    const dx = Math.abs(e.clientX - pointerDownRef.current.x);
    const dy = Math.abs(e.clientY - pointerDownRef.current.y);
    if (dx > 4 || dy > 4) {
      pointerDownRef.current.moved = true;
    }
  }

  function handleMouseUp(e, index) {
    if (e.button !== 0) return;
    const down = pointerDownRef.current;
    pointerDownRef.current = null;
    if (!down) return;
    if (down.index !== index) return;
    if (down.moved) return;
    if (draggedRef.current) return;
    onPlayNow(index);
  }

  return (
    <div className="queue-panel" onClick={closeMenu}>
      <div className="queue-header">
        Queue — {queue.length} track{queue.length !== 1 ? 's' : ''}
      </div>

      <div className="queue-list">
        {queue.length === 0 ? (
          <div className="queue-empty">No tracks yet — add one above</div>
        ) : (
          queue.map((track, i) => (
            <div
              key={`${track.id}-${i}`}
              className={`queue-item${i === currentIndex ? ' current' : ''}${dropIndex === i && dragIndex !== i ? ' drop-target' : ''}`}
              draggable
              onDragStart={(e) => handleDragStart(e, i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={(e) => handleDrop(e, i)}
              onDragEnd={handleDragEnd}
              onContextMenu={(e) => handleContextMenu(e, i)}
              onMouseDown={(e) => handleMouseDown(e, i)}
              onMouseMove={handleMouseMove}
              onMouseUp={(e) => handleMouseUp(e, i)}
              onTouchStart={(e) => {
                longPressTimerRef.current = setTimeout(() => {
                  const touch = e.touches?.[0];
                  setContextMenu({ x: touch?.clientX || 0, y: (touch?.clientY || 0) + 20, index: i });
                  setPlaylistDropdown(null);
                }, 500);
              }}
              onTouchEnd={() => clearTimeout(longPressTimerRef.current)}
              onTouchMove={() => clearTimeout(longPressTimerRef.current)}
            >
              {track.thumbnail && <img src={thumbSrc(track.thumbnail)} alt="" />}
              <div className="queue-item-info">
                <div className="title">{track.title}</div>
                <div className="meta">
                  {i === currentIndex ? '▶ Now Playing' : `Added by ${track.addedBy}`}
                </div>
              </div>
              <span className="drag-handle" title="Drag to reorder">⠿</span>
              <div className="queue-mobile-controls">
                <button
                  className="queue-move-btn"
                  onClick={() => i > 0 && onReorder(i, i - 1)}
                  disabled={i === 0}
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  className="queue-move-btn"
                  onClick={() => i < queue.length - 1 && onReorder(i, i + 1)}
                  disabled={i === queue.length - 1}
                  title="Move down"
                >
                  ↓
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {isDJ && (
            <button
              onClick={() => { onPlayNow(contextMenu.index); closeMenu(); }}
            >
              ▶ Play Now
            </button>
          )}
          <button
            onClick={(e) => { openPlaylistDropdown(e, contextMenu.index); }}
          >
            + Add to Playlist
          </button>
          <button
            onClick={() => { onRemove(contextMenu.index); closeMenu(); }}
          >
            🗑 Delete
          </button>
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
          {playlists.length > 0 ? (
            playlists.map((playlist) => (
              <button
                key={playlist.id}
                className="playlist-dropdown-item"
                onClick={() => addTrackToPlaylist(queue[playlistDropdown.index], playlist.id)}
              >
                {playlist.name}
              </button>
            ))
          ) : (
            <div className="playlist-dropdown-item" style={{ cursor: 'default', color: 'var(--text-muted)' }}>
              No playlists created yet
            </div>
          )}
          <div className="playlist-dropdown-divider" />
          <button
            className="playlist-dropdown-item"
            onClick={() => requestPlaylistCreation(queue[playlistDropdown.index])}
          >
            + New Playlist
          </button>
        </div>
      )}
    </div>
  );
}
