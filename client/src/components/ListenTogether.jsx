import { useState, useEffect, useRef } from 'react';
import './ListenTogether.css';

// Web-only "Listen Together" control. Lets a website visitor spin up a shareable
// room (POST /api/rooms), copy the invite link, leave back to their solo session,
// or join an existing room by code. Switching rooms is a full page navigation so the
// app re-initialises cleanly against the new channelId.
export default function ListenTogether({ roomCode, serverUrl, getSeedState }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const wrapRef = useRef(null);

  // Close the popover when the user clicks anywhere outside it (or presses Escape).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const inRoom = !!roomCode;
  const shareUrl = inRoom ? `${window.location.origin}/room/${roomCode}` : '';
  // How much music the party would inherit. Only read while the create form is
  // showing, so a closed popover costs nothing.
  const queuedCount = open && !inRoom ? getSeedState?.()?.queue?.length ?? 0 : 0;

  async function createRoom() {
    setBusy(true);
    setError('');
    try {
      const base = serverUrl || window.location.origin;
      // Hand the server what's playing right now so the party starts with this
      // listener's queue and playhead instead of an empty room. Read at click
      // time, not render time, so the position is current.
      const seed = getSeedState?.() ?? null;
      const res = await fetch(`${base}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed }),
      });
      if (!res.ok) throw new Error('Failed to create room');
      const { code } = await res.json();
      window.location.assign(`/room/${code}`);
    } catch (err) {
      setError(err.message || 'Could not create room');
      setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copy failed — select and copy the link manually');
    }
  }

  function leaveRoom() {
    window.location.assign('/');
  }

  function joinByCode(e) {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (code) window.location.assign(`/room/${code}`);
  }

  return (
    <div className="lt-wrap" ref={wrapRef}>
      <button
        className={`lt-btn ${inRoom ? 'active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Listen together with friends"
      >
        {inRoom ? `👥 ${roomCode}` : '👥 Listen Together'}
      </button>

      {open && (
        <div className="lt-popover">
          {inRoom ? (
            <>
              <p className="lt-label">Share this link so friends can join:</p>
              <div className="lt-row">
                <input className="lt-input" readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
                <button className="lt-copy" onClick={copyLink}>{copied ? '✓' : 'Copy'}</button>
              </div>
              <button className="lt-leave" onClick={leaveRoom}>Leave room</button>
            </>
          ) : (
            <>
              <button className="lt-create" onClick={createRoom} disabled={busy}>
                {busy ? 'Creating…' : 'Create a room'}
              </button>
              {queuedCount > 0 && (
                <p className="lt-carry-note">
                  Your {queuedCount === 1 ? 'track' : `${queuedCount} tracks`} and playback
                  position come with you.
                </p>
              )}
              <div className="lt-divider"><span>or</span></div>
              <form className="lt-row" onSubmit={joinByCode}>
                <input
                  className="lt-input"
                  placeholder="Enter code"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  maxLength={8}
                />
                <button className="lt-copy" type="submit" disabled={!joinCode.trim()}>Join</button>
              </form>
            </>
          )}
          {error && <p className="lt-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
