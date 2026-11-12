// Verification harness for the mailto builder. Not shipped in the bundle.
//
// Proves the two failure modes that matter: (1) a body that survives round-trip decoding
// byte-for-byte, so nothing is silently truncated; (2) CRLF line breaks encoded as %0D%0A.
// Run: node scripts/verify-mailto.mjs
import { buildMailto, firstName } from "../src/lib/mailto.js";
import { accountInviteEmail, intakeInviteEmail } from "../src/lib/inviteCopy.js";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// Hostile-but-realistic inputs: apostrophe in the surname, ampersand + question mark +
// hash + plus in the address and link, plus an apostrophe in the display name.
const client = { display_name: "Sam O'Rivera", email: "sam.o'rivera+coach@example.com" };
const link = "https://app.example.com/claim?token=ab12&x=1#frag";

for (const [name, make] of [["account", accountInviteEmail], ["intake", intakeInviteEmail]]) {
  const { subject, body } = make({ displayName: client.display_name, link });
  const url = buildMailto({ to: client.email, subject, body });

  console.log(`\n===== ${name} =====\n${url}\n`);

  const q = url.slice(url.indexOf("?") + 1);
  const params = new URLSearchParams(q);
  const decodedBody = params.get("body");
  const decodedSubject = params.get("subject");

  check(`${name}: subject round-trips exactly`, decodedSubject === subject);
  check(`${name}: body round-trips exactly`, decodedBody === body.replace(/\n/g, "\r\n"));
  check(`${name}: line breaks encoded as %0D%0A`, url.includes("%0D%0A"));
  check(`${name}: no bare %0A without %0D`, !/(?<!%0D)%0A/.test(url));
  check(`${name}: apostrophe escaped as %27`, url.includes("%27") && !/\?[^]*'/.test(url.slice(url.indexOf("?"))));
  check(`${name}: ampersand in link escaped as %26`, url.includes("%26"));
  check(`${name}: link hash escaped as %23`, url.includes("%23"));
  check(`${name}: exactly one '?' separator`, url.split("?").length === 2);
  check(`${name}: recipient readable with @`, url.startsWith("mailto:") && url.slice(7, url.indexOf("?")).includes("@"));
  check(`${name}: full link present after decode`, decodedBody.includes(link));
  check(`${name}: no exclamation marks in copy`, !body.includes("!") && !subject.includes("!"));
  check(`${name}: greeting uses first name only`, decodedBody.startsWith("Sam,"));

  console.log(`\n--- decoded body as the client sees it ---\n${decodedBody}\n`);
}

// Degradation cases.
check("empty name → no dangling comma", !accountInviteEmail({ displayName: "  ", link }).body.startsWith(","));
check("null name → no crash", typeof accountInviteEmail({ displayName: null, link }).body === "string");
check("firstName trims", firstName("  Dana   Wu ") === "Dana");
check("no address → mailto: with empty path", buildMailto({ subject: "x" }).startsWith("mailto:?"));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
