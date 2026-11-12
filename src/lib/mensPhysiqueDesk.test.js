import test from "node:test";
import assert from "node:assert/strict";
import {
  MENS_PHYSIQUE_RADIO,
  MENS_PHYSIQUE_RULE_LINKS,
  shouldShowMensPhysiqueDesk,
} from "./mensPhysiqueDesk.js";

test("only prep clients see the Men's Physique desk", () => {
  assert.equal(shouldShowMensPhysiqueDesk({ client_type: "prep" }), true);
  assert.equal(shouldShowMensPhysiqueDesk({ client_type: "lifestyle" }), false);
  assert.equal(shouldShowMensPhysiqueDesk({ client_type: null }), false);
  assert.equal(shouldShowMensPhysiqueDesk({}), false);
  assert.equal(shouldShowMensPhysiqueDesk(null), false);
});

test("radio points at the observed Men's Physique Radio channel", () => {
  assert.equal(MENS_PHYSIQUE_RADIO.channelUrl, "https://www.youtube.com/@MENSPHYSIQUERADIO");
  assert.equal(MENS_PHYSIQUE_RADIO.channelId, "UCX27xHyX9OwuTvsgM-DvRcw");
  assert.match(MENS_PHYSIQUE_RADIO.embedSrc, /youtube-nocookie\.com\/embed\/videoseries/);
  assert.match(MENS_PHYSIQUE_RADIO.embedSrc, /list=UUX27xHyX9OwuTvsgM-DvRcw/);
});

test("rule links are official federation pages, not blogs", () => {
  const hrefs = MENS_PHYSIQUE_RULE_LINKS.map((l) => l.href);
  assert.deepEqual(hrefs, [
    "https://npcnewsonline.com/official-npc-mens-physique-division",
    "https://npcnewsonline.com/npc-ifbb-pro-natural-contest-rules",
    "https://ifbbpro.com/rules",
    "https://ifbb.com/wp-content/uploads/2025/04/Mens-Physique-2024.pdf",
  ]);
  assert.equal(MENS_PHYSIQUE_RULE_LINKS.length, 4);
});
