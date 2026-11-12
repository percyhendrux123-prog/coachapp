import { useAuth } from "../context/AuthContext";
import { CoachTabs } from "../components/CoachTabs";
import AppGate from "../components/AppGate";
import PromoLinkField from "../components/PromoLinkField";
import BriefSlidesManager from "../components/BriefSlidesManager";
import KnowledgeCard from "../components/KnowledgeCard";
import { isOwnerTenant } from "../lib/tenantIdentity";

// Permanent coach front door. Code sign-in and first open land here.
// The stage is the subject: empty plate and playing video are the same size.
// Remotion slide tracks can sit on this stage later without a new page.
export default function CoachBrief() {
  const { user, role, profile, tenant } = useAuth();

  if (!user) {
    return (
      <AppGate title="Sign in to open the briefing" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        Current promotional video lives here after you sign in.
      </AppGate>
    );
  }
  if (role !== "coach") {
    return (
      <AppGate title="Coach area only" actionTo="/client" actionLabel="My coaching" secondaryTo="/" secondaryLabel="Home">
        Briefing is for coaches.
      </AppGate>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <CoachTabs active="brief" />
      <header className="mt-6">
        <span className="kicker">Front door</span>
        <h1 className="display mt-1 text-3xl md:text-4xl">Briefing</h1>
        <p className="mt-2 max-w-[52ch] text-sm opacity-60">
          Paste this week’s reel. The window does not change size. Home is still
          triage — this tab stays.
        </p>
      </header>
      {profile?.tenant_id && <PromoLinkField tenantId={profile.tenant_id} />}
      {profile?.tenant_id && <BriefSlidesManager tenantId={profile.tenant_id} />}
      {isOwnerTenant(tenant) && <KnowledgeCard />}
    </main>
  );
}
