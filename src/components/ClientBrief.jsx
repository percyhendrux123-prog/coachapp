import PromoStage from "./PromoStage";
import BriefSlideStrip from "./BriefSlideStrip";
import KnowledgeCard from "./KnowledgeCard";
import MensPhysiqueDesk from "./MensPhysiqueDesk";

// Client front door. Same plate as coach Brief — watch only. Coach sets the
// link in Settings / Brief. First-login stay is the built-in mp4, not this tab.
// Prep clients also get the Men's Physique desk. Lifestyle never does.
// White-label tenants see Knowledge only if their config enables the owned surface.
export default function ClientBrief({ branding, state = "ready", onRetry, showPrepDesk = false, showKnowledge = true }) {
  const url = (branding?.welcome_video_url || "").trim();

  return (
    <div>
      <span className="kicker">Front door</span>
      <h2 className="display mt-1 text-2xl md:text-3xl">Briefing</h2>
      <p className="mt-2 max-w-[46ch] text-sm opacity-60">
        This week’s reel. The window does not change size.
      </p>
      <div className="mt-6">
        {state === "loading" ? (
          <div className="glass flex min-h-48 items-center justify-center p-4 text-sm opacity-60">
            Loading this week’s Brief…
          </div>
        ) : state === "failed" ? (
          <div className="glass border-dashed p-4 text-center" role="alert">
            <p className="text-sm font-semibold">Could not load this week’s Brief</p>
            <p className="mt-1 text-xs opacity-60">This is a failed read, not confirmation that no reel is set.</p>
            {onRetry && <button type="button" onClick={onRetry} className="btn-ghost mt-4 px-4 text-sm">Retry Brief</button>}
          </div>
        ) : (
          <PromoStage
            url={url}
            emptyHint="Your coach has not set this week’s reel yet. The plate stays."
          />
        )}
      </div>
      <BriefSlideStrip />
      {showPrepDesk && <MensPhysiqueDesk />}
      {showKnowledge && <KnowledgeCard compact />}
    </div>
  );
}
