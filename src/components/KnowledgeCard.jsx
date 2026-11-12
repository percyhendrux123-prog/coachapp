import { Link } from "react-router-dom";

// `compact` (2026-08-30, implementation): on the client Brief the reel and slides are the
// briefing; Knowledge is adjacent content and gets one quiet row instead of a
// competing card. The coach Brief and other surfaces keep the full card.
export default function KnowledgeCard({ compact = false }) {
  if (compact) {
    return (
      <Link
        to="/knowledge"
        className="glass mt-6 flex items-center justify-between gap-3 px-4 py-3 transition hover:border-brand/30"
      >
        <span className="min-w-0">
          <span className="text-sm font-semibold">Knowledge</span>
          <span className="ml-2 text-xs opacity-60">Articles and guidance from your coach.</span>
        </span>
        <span className="shrink-0 text-xs font-semibold uppercase tracking-[0.12em] text-brand-fg">Open →</span>
      </Link>
    );
  }
  return (
    <Link
      to="/knowledge"
      className="glass mt-6 block p-4 transition hover:border-brand/30"
    >
      <span className="kicker">Knowledge</span>
      <p className="display mt-1 text-xl">Your knowledge library</p>
      <p className="mt-2 max-w-[42ch] text-sm leading-relaxed opacity-60">
        A placeholder for your own articles and guidance for clients.
      </p>
      <p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-brand-fg">
        Open →
      </p>
    </Link>
  );
}
