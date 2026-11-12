// Parity test between src/lib/attribution.js and its hand-maintained Deno twin,
// attribution.ts. There's no automated sync between the two — this is the only thing that
// catches drift when one changes without the other. Run with:
//   deno test --no-check --allow-read supabase/functions/_shared/attribution.parity.test.ts
// --no-check is required to import the plain-JS twin without Deno's type checker tripping on
// the lack of static types there — this is a runtime-output parity check, not a type check
// (same rationale as effectiveDays.parity.test.ts).
//
// Why it matters here specifically: the browser sanitizes before sending and the server
// sanitizes again on arrival. If the two disagree, a legitimate tag can be quietly rewritten
// between the click and the charge, and the campaign it belonged to loses the sale.

// @ts-nocheck
import { sanitizeAttribution as jsSanitize, attributionRef as jsRef } from "../../../src/lib/attribution.js";
import { sanitizeAttribution as tsSanitize, attributionRef as tsRef } from "./attribution.ts";

function assertDeepEqual(a: unknown, b: unknown, label: string) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) {
    throw new Error(`${label}: JS and TS twins disagree.\n  JS: ${sa}\n  TS: ${sb}`);
  }
}

const CASES: Record<string, unknown> = {
  empty: {},
  nullish: null,
  notAnObject: "src=ig",
  fullyTagged: {
    src: "ig", med: "reel", camp: "system-q4", cnt: "2026-09-10-hook-01",
    landing: "app.example.com", first_touch_at: "2026-09-08T14:24:00.000Z",
  },
  mixedCaseAndSpaces: { src: "  IG ", med: "Re el", camp: " System Q4 ", cnt: "Hook 01" },
  injectionAttempt: { src: "ig'; drop table--", med: "<script>", camp: "a/b?c=d", cnt: "../../etc/passwd" },
  unicode: { src: "інстаграм", med: "リール", camp: "café", cnt: "emoji" },
  overlong: { src: "s".repeat(300), med: "m".repeat(65), camp: "c".repeat(64), cnt: "n".repeat(63) },
  onlyIllegalCharacters: { src: "!!!", med: "@@@", camp: "###", cnt: "   " },
  partial: { src: "yt" },
  hostWithPort: { landing: "app.example.com:443" },
  looseTimestamp: { first_touch_at: "2026-09-08T14:24:00Z" },
  badTimestamp: { first_touch_at: "last tuesday" },
  overlongTimestamp: { first_touch_at: "2026-09-08T14:24:00.000Z".repeat(3) },
  numericFields: { src: 12, med: 0, camp: false, cnt: 3.5 },
};

for (const [name, input] of Object.entries(CASES)) {
  Deno.test(`attribution parity: ${name}`, () => {
    const js = jsSanitize(input);
    const ts = tsSanitize(input);
    assertDeepEqual(js, ts, `sanitizeAttribution(${name})`);
    assertDeepEqual(jsRef(js), tsRef(ts), `attributionRef(${name})`);
  });
}
