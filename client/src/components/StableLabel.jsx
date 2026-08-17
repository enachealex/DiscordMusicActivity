// A label that always reserves room for the widest string it could hold, so a
// control cannot resize when its state changes.
//
// A hardcoded min-width would not survive the trip: these labels are measured in
// Segoe UI on the dev machine and rendered in Roboto on the phone, and a value
// tuned to one font is wrong in the other. Stacking every candidate in a single
// grid cell lets the browser size the box to whichever is actually widest, in
// whatever font it ends up drawing.
export default function StableLabel({ value, alternatives }) {
  return (
    <span className="stable-label">
      <span className="stable-label-value">{value}</span>
      {alternatives
        .filter((alternative) => alternative !== value)
        .map((alternative) => (
          <span key={alternative} className="stable-label-ghost" aria-hidden="true">
            {alternative}
          </span>
        ))}
    </span>
  );
}
