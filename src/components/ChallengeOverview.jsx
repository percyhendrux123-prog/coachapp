// The public face of a challenge: title, subtitle, description and the standards list,
// with the call to action passed in. Shared by the live page (src/pages/Challenge.jsx)
// and the fixture preview so both render the same thing.
export default function ChallengeOverview({ challenge, standards, children, footer }) {
  return (
    <>
      <h1 className="display text-2xl sm:text-4xl md:text-5xl">{challenge.title}</h1>
      {challenge.subtitle && <p className="mt-3 text-lg leading-snug opacity-70">{challenge.subtitle}</p>}
      {challenge.description && <p className="mt-3 text-sm opacity-70">{challenge.description}</p>}

      <h2 className="section-title mt-10">The {standards.length} standards</h2>
      <ol className="mt-3 space-y-2">
        {standards.map((s, i) => (
          <li key={s.id} className="glass flex items-baseline gap-3 px-4 py-3 text-sm">
            <span className="display shrink-0 text-lg opacity-30">{String(i + 1).padStart(2, "0")}</span>
            <span><span className="font-bold">{s.title}</span>{s.description ? <span className="opacity-70"> — {s.description}</span> : ""}</span>
          </li>
        ))}
      </ol>

      <div className="mt-8">{children}</div>
      {footer ? <p className="mt-3 text-center text-xs opacity-50">{footer}</p> : null}
    </>
  );
}
