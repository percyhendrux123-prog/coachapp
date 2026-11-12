// Hand-rolled inline-SVG line chart — no chart library, matching house convention
// (Tailwind + hand-rolled components everywhere else in this app). Renders a
// polyline through {date, value} points plus min/max/latest callouts. `points`
// must already be sorted ascending by date and use the display unit the caller
// wants shown (unit conversion happens at the call site, not in here).
const WIDTH = 300;
const HEIGHT = 100;
const PAD = 8;

export default function TrendChart({ points, unit = "", formatValue = (v) => v }) {
  if (!Array.isArray(points) || points.length === 0) return null;

  if (points.length === 1) {
    return (
      <p className="text-sm opacity-70">
        One point logged so far: {formatValue(points[0].value)}{unit}. A trend needs at least two.
      </p>
    );
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1; // flat line (all equal) still renders, not a divide-by-zero

  const xAt = (i) => PAD + (i / (points.length - 1)) * (WIDTH - PAD * 2);
  const yAt = (v) => HEIGHT - PAD - ((v - min) / span) * (HEIGHT - PAD * 2);

  const linePoints = points.map((p, i) => `${xAt(i)},${yAt(p.value)}`).join(" ");
  const latest = points[points.length - 1];

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-24 w-full text-brand-fg"
        role="img"
        aria-label={`Trend from ${formatValue(points[0].value)}${unit} to ${formatValue(latest.value)}${unit} across ${points.length} points`}
      >
        <polyline points={linePoints} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={p.date} cx={xAt(i)} cy={yAt(p.value)} r="2" fill="currentColor" />
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] opacity-60">
        <span>Low {formatValue(min)}{unit}</span>
        <span className="font-semibold text-brand-fg">Latest {formatValue(latest.value)}{unit}</span>
        <span>High {formatValue(max)}{unit}</span>
      </div>
    </div>
  );
}
