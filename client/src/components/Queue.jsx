import { useRef, useState } from 'react';

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
  const pointerDownRef = useRef(null);
  const draggedRef = useRef(false);

  function handleContextMenu(e, index) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, index });
  }

  function closeMenu() {
    setContextMenu(null);
  }

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
