import { useState, useEffect, useRef } from 'react';
import './DiscordParty.css';

// Discord-only "Listen Together" join/leave control. Any Discord user — solo with the
// bot, in a voice channel, or in a group — can enter a code to join a shared party, and
// leave to return to their own room. Switching rooms happens via an in-place socket
// reconnect (Discord can't navigate to /room/CODE the way the web client does).
export default function DiscordParty({ partyCode, onJoin, onLeave }) {
  const [open, setOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const wrapRef = useRef(null);

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

  function submitJoin(e) {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (code) {
      onJoin(code);
      setOpen(false);
      setJoinCode('');
    }
  }

  if (partyCode) {
    return (
      <button className="dp-btn active" onClick={onLeave} title="Leave the party">
        🚪 Leave Party
      </button>
    );
  }

  return (
    <div className="dp-wrap" ref={wrapRef}>
      <button
        className="dp-btn"
        onClick={() => setOpen((o) => !o)}
        title="Join a Listen Together party by code"
      >
        👥 Join Party
      </button>
      {open && (
        <div className="dp-popover">
          <p className="dp-label">Enter a party code to listen together:</p>
          <form className="dp-row" onSubmit={submitJoin}>
            <input
              className="dp-input"
              placeholder="Code"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              maxLength={8}
              autoFocus
            />
            <button className="dp-join" type="submit" disabled={!joinCode.trim()}>
              Join
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
