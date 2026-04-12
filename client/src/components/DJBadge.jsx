export default function DJBadge({ isDJ }) {
  if (!isDJ) return null;
  return <div className="dj-badge">🎧 DJ</div>;
}
