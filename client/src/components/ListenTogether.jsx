import { useState } from 'react';
import './ListenTogether.css';

// Web-only "Listen Together" control. Lets a website visitor spin up a shareable
// room (POST /api/rooms), copy the invite link, leave back to their solo session,
// or join an existing room by code. Switching rooms is a full page navigation so the
// app re-initialises cleanly against the new channelId.
export default function ListenTogether({ roomCode, serverUrl }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');

  const inRoom = !!roomCode;
  const shareUrl = inRoom ? `${window.location.origin}/room/${roomCode}` : '';

  async function createRoom() {
    setBusy(true);
    setError('');
    try {
      const base = serverUrl || window.location.origin;
      const res = await fetch(`${base}/api/rooms`, { method: 'POST' });
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
    <div className="lt-wrap">
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
