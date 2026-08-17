import './BackgroundPlaybackPrompt.css';

// Shown once, when the listener comes back after leaving the app for the first time
// while music was playing. Asking on the way out is pointless — they aren't looking
// at the screen — so the wording refers to what just happened.
export default function BackgroundPlaybackPrompt({ onAllow, onDecline }) {
  return (
    <div className="bgp-overlay" role="dialog" aria-modal="true" aria-labelledby="bgp-title">
      <div className="bgp-card">
        <h2 className="bgp-title" id="bgp-title">Keep playing in the background?</h2>
        <p className="bgp-body">
          Show playback in your notification shade and on the lock screen, with play,
          pause and skip — and keep the music going while you're in other apps.
        </p>
        <p className="bgp-note">Adds an ongoing notification while something is playing.</p>
        <div className="bgp-actions">
          <button type="button" className="bgp-btn bgp-btn-secondary" onClick={onDecline}>
            Not now
          </button>
          <button type="button" className="bgp-btn bgp-btn-primary" onClick={onAllow}>
            Yes, keep playing
          </button>
        </div>
        <p className="bgp-footnote">You can change this any time in the audio menu.</p>
      </div>
    </div>
  );
}
