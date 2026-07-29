import './QueueMemory.css';

// Web-only preference: keep this browser's solo queue between visits.
//
// The switch is the whole feature surface — there is nothing to consent to beyond
// it, because the queue is written to this browser's localStorage and never sent
// anywhere. Turning it off deletes what was stored (see queueMemory.js).
export default function QueueMemory({ enabled, onChange, trackCount }) {
  return (
    <div className="queue-memory">
      <label className="qm-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="qm-label">Remember my queue</span>
      </label>
      <span className="qm-note">
        {enabled
          ? trackCount > 0
            ? `${trackCount} ${trackCount === 1 ? 'track' : 'tracks'} kept in this browser only`
            : 'Kept in this browser only — never sent anywhere'
          : 'Your queue is cleared when you leave'}
      </span>
    </div>
  );
}
