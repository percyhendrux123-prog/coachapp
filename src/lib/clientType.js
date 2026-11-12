// Client classification — lifestyle vs prep, and the show date that makes a prep
// client legible.
//
// WHY THIS MODULE EXISTS AS ONE PLACE. client_type now appears in four surfaces
// (roster badge, add-client form, profile editor, bulk classifier). The rule that
// NULL is not lifestyle has to hold identically in all four, or the one that gets
// it wrong is the one that quietly reclassifies 30 people. One module, one rule.
//
// THE RULE, from the column comment in the database:
//   "NULL means the intake did not state it — that is a gap to resolve with the
//    client, never a value to default. Nothing downstream may assume lifestyle
//    because the column is empty."
//
// So: three states, not two. lifestyle · prep · unclassified. `unclassified` is a
// fact about the owner's system, not about the client, and it renders as an obviously
// empty slot rather than as a value.

export const CLIENT_TYPES = [
  { value: "lifestyle", label: "Lifestyle" },
  { value: "prep", label: "Prep" },
];

export const CLIENT_TYPE_VALUES = CLIENT_TYPES.map((t) => t.value);

// the owner's own test client is excluded from every classification prompt and every
// count. He is not a client to be coached and counting him makes the "how many
// left to classify" number wrong forever.
//
// Matched on the display name because that is what identifies it — there is no
// is_test column, and inventing one to hold a single row is the wrong trade.
// If the name changes this stops matching, which is why it is one exported
// predicate and not a string buried in a component.
const TEST_CLIENT_NAMES = ["test client"];

export function isTestClient(client) {
  const name = (client?.display_name ?? "").trim().toLowerCase();
  return TEST_CLIENT_NAMES.includes(name);
}

/**
 * The classification state of a client. Deliberately returns "unclassified"
 * rather than falling back to lifestyle — see the module header.
 */
export function classificationOf(client) {
  const t = client?.client_type;
  if (t === "prep" || t === "lifestyle") return t;
  return "unclassified";
}

export function classificationLabel(client) {
  const s = classificationOf(client);
  if (s === "unclassified") return "Not classified";
  return s === "prep" ? "Prep" : "Lifestyle";
}

/**
 * Whole days from today until the show. Null when there is no date — never 0,
 * never "soon". A missing date is not a near date.
 */
export function daysOut(showDate) {
  if (!showDate) return null;
  const d = new Date(`${showDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  const t0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const t1 = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((t1 - t0) / 86400000);
}

export function daysOutLabel(showDate) {
  const n = daysOut(showDate);
  if (n === null) return null;
  if (n === 0) return "show today";
  if (n < 0) return `${Math.abs(n)}d past`;
  return `${n}d out`;
}

/**
 * THE GAP THIS SURFACES. A prep client with no show date is a prep client the
 * system cannot reason about: no days-out, no peak-week window, and no way to
 * tell expected late-prep physiology from an avoidance signal.
 *
 * Verified 2026-07-31: 0 of 31 active clients have a show date recorded. So this
 * fires for every prep client the moment one is classified, which is correct —
 * it is a real, currently-universal gap, not a rare edge case.
 */
export function prepMissingShowDate(client) {
  return classificationOf(client) === "prep" && !client?.show_date;
}

/**
 * Roster counts. Excludes the test client from both numerator and denominator so
 * "3 of 31 classified" means what it says.
 */
export function classificationCounts(clients = []) {
  const real = clients.filter((c) => !isTestClient(c));
  const counts = { total: real.length, lifestyle: 0, prep: 0, unclassified: 0, prepNoShowDate: 0 };
  for (const c of real) {
    counts[classificationOf(c)] += 1;
    if (prepMissingShowDate(c)) counts.prepNoShowDate += 1;
  }
  return counts;
}
