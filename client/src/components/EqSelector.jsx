import './EqSelector.css';

// Web-only audio EQ preset picker. Personal to each listener (does not affect the
// shared room or Discord). Applies via WebAudio shelving filters in YouTubePlayer.
const OPTIONS = [
  { id: 'flat', label: 'Flat', title: 'No EQ — original sound' },
  { id: 'bass', label: 'Bass', title: 'Boost low frequencies' },
  { id: 'treble', label: 'Treble', title: 'Boost high frequencies' },
  { id: 'vocal', label: 'Vocal', title: 'Emphasize vocals' },
];

export default function EqSelector({ value, onChange }) {
  return (
    <div className="eq-selector" role="group" aria-label="Audio EQ">
      <span className="eq-selector-label">EQ</span>
      {OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className={`eq-chip${value === opt.id ? ' active' : ''}`}
          onClick={() => onChange(opt.id)}
          title={opt.title}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
