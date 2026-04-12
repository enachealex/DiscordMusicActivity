import { useState } from 'react';

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

  function handleContextMenu(e, index) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, index });
  }

  function closeMenu() {
    setContextMenu(null);
  }

  function handleDragStart(e, index) {
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
    setDragIndex(null);
    setDropIndex(null);
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
            >
              {track.thumbnail && <img src={thumbSrc(track.thumbnail)} alt="" />}
              <div className="queue-item-info">
                <div className="title">{track.title}</div>
                <div className="meta">
                  {i === currentIndex ? '▶ Now Playing' : `Added by ${track.addedBy}`}
                </div>
              </div>
              <span className="drag-handle" title="Drag to reorder">⠿</span>
            </div>
          ))
        )}
      </div>

      {contextMenu && (
        <div
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
            onClick={() => { onRemove(contextMenu.index); closeMenu(); }}
          >
            🗑 Delete
          </button>
        </div>
      )}
    </div>
  );
}
