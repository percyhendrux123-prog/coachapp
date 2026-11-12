// Men's Physique competitor desk. Shown only on Brief when client_type is prep.
// Lifestyle / unclassified clients must not see this. Federation pages are
// official sources; we point, we do not rewrite the rulebooks.

export const MENS_PHYSIQUE_RADIO = {
  title: "Men’s Physique Radio",
  handle: "@MENSPHYSIQUERADIO",
  channelUrl: "https://www.youtube.com/@MENSPHYSIQUERADIO",
  channelId: "UCX27xHyX9OwuTvsgM-DvRcw",
  // Uploads playlist = UC… → UU…
  embedSrc:
    "https://www.youtube-nocookie.com/embed/videoseries?list=UUX27xHyX9OwuTvsgM-DvRcw&rel=0&modestbranding=1",
};

export const MENS_PHYSIQUE_RULE_LINKS = [
  {
    id: "npc-mens-physique",
    title: "NPC Men’s Physique",
    source: "NPC News Online",
    why: "Board shorts, height classes, judging and finals for the amateur US division.",
    href: "https://npcnewsonline.com/official-npc-mens-physique-division",
  },
  {
    id: "npc-ifbb-pro-natural",
    title: "NPC / IFBB Pro Natural",
    source: "NPC News Online",
    why: "Natural contest testing windows, prohibited list, and qualifier rules.",
    href: "https://npcnewsonline.com/npc-ifbb-pro-natural-contest-rules",
  },
  {
    id: "ifbb-pro-league",
    title: "IFBB Professional League",
    source: "IFBBPRO.com",
    why: "Current pro competition rules. Confirm the Men’s Physique section for the show you enter.",
    href: "https://ifbbpro.com/rules",
  },
  {
    id: "ifbb-federation-mens-physique",
    title: "IFBB Federation Men’s Physique",
    source: "IFBB.com 2024 PDF",
    why: "International amateur Men’s Physique rulebook (poses, attire, rounds).",
    href: "https://ifbb.com/wp-content/uploads/2025/04/Mens-Physique-2024.pdf",
  },
];

export function shouldShowMensPhysiqueDesk(client) {
  return client?.client_type === "prep";
}
