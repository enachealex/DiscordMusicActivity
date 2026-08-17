// Shown when the server announces it is restarting for an update.
//
// The point is to replace a silent, alarming event — the music stops and the
// queue looks empty — with an explanation and an outcome. A solo listener's
// queue is held in their own browser and comes back automatically, so the notice
// says so and clears itself once the connection returns. A party is a different
// story: the shared room lives only in the server's memory, so it genuinely does
// not survive, and saying otherwise would be a lie.
export default function UpdateNotice({ phase, inParty }) {
  if (!phase) return null;

  const reconnected = phase === 'reconnected';
  const message = reconnected
    ? inParty
      ? 'Back online. The party room was reset — start a new one to listen together again.'
      : 'Back online. Your queue has been restored.'
    : inParty
      ? 'Updating the app. The party room will not survive the restart, but your own queue is kept on this device.'
      : 'Updating the app. Your queue is saved on this device and comes back in a few seconds.';

  return (
    <div className={`update-notice${reconnected ? ' update-notice--done' : ''}`} role="status" aria-live="polite">
      <span className="update-notice-dot" aria-hidden="true" />
      <span className="update-notice-text">{message}</span>
    </div>
  );
}
