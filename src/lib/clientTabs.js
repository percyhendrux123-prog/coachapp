// The client app's primary tab bar — single source of truth, shared with
// ClientPreview's mock nav so the marketing-facing preview cannot drift from the
// real bar (the implementation reorder had to be applied twice because a hand copy had).
// Order = the client's day, not the coach's publishing schedule (2026-08-30, implementation):
// the landing tab has always been Train, but Brief sat first in the bar, which read
// as "Brief is home." The bar leads with the daily jobs; Brief keeps its identity
// as the weekly reel, last.
const COACHED_PRIMARY = [
  { id: "program", label: "Program", short: "Train" },
  { id: "nutrition", label: "Nutrition", short: "Meals" },
  { id: "check-in", label: "Check-in", short: "Check" },
  { id: "brief", label: "Brief", short: "Brief" },
];

// Anything that is not exactly 'self_serve' renders as coached — today's UI. A missing or
// failed tenant_config read must never strip a coached client's tabs.
export const isSelfServeMode = (mode) => mode === "self_serve";

export function primaryTabsFor(mode) {
  return isSelfServeMode(mode) ? COACHED_PRIMARY.filter((t) => t.id !== "brief") : COACHED_PRIMARY;
}

export const PRIMARY_TABS = primaryTabsFor("coached");

// The More sheet. Coach-dependent surfaces (Messages, Videos, Resources, Content,
// Community, About) do not exist in self-serve — there is no coach to author them and
// Community would pool every buyer into one room (spec §4).
export function moreTabsFor({ mode, messagingOn, ownedContent }) {
  const self = isSelfServeMode(mode);
  return [
    !self && messagingOn ? { id: "messages", label: "Messages" } : null,
    { id: "activity", label: "Activity" },
    { id: "history", label: "Calendar" },
    { id: "progress", label: "Progress" },
    !self ? { id: "videos", label: "Videos" } : null,
    !self ? { id: "resources", label: "Resources" } : null,
    !self && ownedContent ? { id: "content", label: "Content" } : null,
    !self ? { id: "community", label: "Community" } : null,
    { id: "profile", label: "Profile" },
    { id: "settings", label: "Settings" },
    !self ? { id: "about", label: "About" } : null,
  ].filter(Boolean);
}
