// deno test supabase/functions/_shared/challengeEnroll.test.ts
import { enrollDecision, hasCurrentCoachingRelationship, isChallengeFull, isUniqueViolation } from "./challengeEnroll.ts";

const published = { id: "c1", status: "published", audience: "open" };

Deno.test("a published, open challenge admits a new participant", () => {
  const d = enrollDecision({ challenge: published, isClient: false });
  if (!d.ok) throw new Error(JSON.stringify(d));
});

Deno.test("an archived challenge is refused with 409", () => {
  const d = enrollDecision({ challenge: { ...published, status: "archived" }, isClient: false });
  if (d.ok || d.status !== 409 || !/archived/.test(String(d.error))) throw new Error(JSON.stringify(d));
});

Deno.test("a draft (unpublished) challenge is refused — unpublishing must stop the API, not just the page", () => {
  const d = enrollDecision({ challenge: { ...published, status: "draft" }, isClient: false });
  if (d.ok || d.status !== 409 || !/not open for enrollment/.test(String(d.error))) throw new Error(JSON.stringify(d));
});

Deno.test("non_clients_only refuses an existing client with 403, admits a stranger", () => {
  const ch = { ...published, audience: "non_clients_only" };
  const client = enrollDecision({ challenge: ch, isClient: true });
  if (client.ok || client.status !== 403 || !/current coaching clients/.test(String(client.error))) throw new Error(JSON.stringify(client));
  const stranger = enrollDecision({ challenge: ch, isClient: false });
  if (!stranger.ok) throw new Error(JSON.stringify(stranger));
});

Deno.test("clients_only refuses a stranger with 403, admits a client", () => {
  const ch = { ...published, audience: "clients_only" };
  const stranger = enrollDecision({ challenge: ch, isClient: false });
  if (stranger.ok || stranger.status !== 403 || !/existing clients only/.test(String(stranger.error))) throw new Error(JSON.stringify(stranger));
  const client = enrollDecision({ challenge: ch, isClient: true });
  if (!client.ok) throw new Error(JSON.stringify(client));
});

Deno.test("an unknown audience value is refused rather than treated as open", () => {
  const d = enrollDecision({ challenge: { ...published, audience: "vip" }, isClient: false });
  if (d.ok || d.status !== 409) throw new Error(JSON.stringify(d));
});

Deno.test("the audience gate needs the client lookup only when the audience is restricted", () => {
  const { needsClientLookup } = enrollDecision({ challenge: published, isClient: undefined }) as any;
  if (needsClientLookup !== false) throw new Error("open challenge must not need a client lookup");
  const restricted = enrollDecision({ challenge: { ...published, audience: "non_clients_only" }, isClient: undefined }) as any;
  if (restricted.needsClientLookup !== true || restricted.ok !== undefined) throw new Error(JSON.stringify(restricted));
});

Deno.test("a unique-violation on insert is recognised so a concurrent double-enroll resolves to the existing run", () => {
  if (!isUniqueViolation({ code: "23505", message: "duplicate key value violates unique constraint" })) throw new Error("23505 must be recognised");
  if (isUniqueViolation({ code: "42501", message: "permission denied" })) throw new Error("other codes are not unique violations");
  if (isUniqueViolation(null)) throw new Error("null is not a violation");
});

Deno.test("the database capacity refusal is recognised so a full challenge answers 409, not 500", () => {
  if (!isChallengeFull({ code: "P0001", message: "challenge is full", hint: "challenge_full" })) throw new Error("hint form");
  if (!isChallengeFull({ code: "P0001", message: "challenge is full" })) throw new Error("message form");
  if (isChallengeFull({ code: "P0001", message: "release refused: program" })) throw new Error("other P0001 must not match");
});

// --- current-relationship predicate (2026-09-10 eligibility fix) -------------------------
// Policy: eligible for a non_clients_only challenge = no CURRENT coaching
// relationship. A historical clients row alone does not make someone a client.

const rel = hasCurrentCoachingRelationship;

Deno.test("no clients row at all is not a client (a stranger)", () => {
  if (rel(null) || rel(undefined)) throw new Error("null/undefined must be false");
});

Deno.test("an archived former client is NOT a client — eligible again", () => {
  if (rel({ status: "archived", subscription_status: null })) throw new Error("archived must be false");
  if (rel({ status: "archived", subscription_status: "canceled" })) throw new Error("archived + canceled billing must be false");
});

Deno.test("an old intake that never started (invited, no live billing) is NOT a client", () => {
  if (rel({ status: "invited", subscription_status: null })) throw new Error("invited must be false");
  if (rel({ status: "invited", subscription_status: "canceled" })) throw new Error("invited + canceled must be false");
  if (rel({ status: "invited", subscription_status: "unpaid" })) throw new Error("invited + unpaid must be false");
});

Deno.test("an active client IS a client, whatever the tier or billing column says", () => {
  if (!rel({ status: "active", subscription_status: null })) throw new Error("active must be true");
  if (!rel({ status: "active", subscription_status: "canceled" })) throw new Error("active status wins over a stale billing column");
});

Deno.test("a paused client still has a coaching relationship — NOT eligible", () => {
  if (!rel({ status: "paused", subscription_status: null })) throw new Error("paused must be true");
});

Deno.test("live coaching billing counts even when the status is mislabeled as invited", () => {
  if (!rel({ status: "invited", subscription_status: "active" })) throw new Error("invited + active billing must be true");
  if (!rel({ status: "invited", subscription_status: "trialing" })) throw new Error("trialing is live billing");
  if (!rel({ status: "invited", subscription_status: "past_due" })) throw new Error("past_due is still a live relationship (dunning)");
});

Deno.test("a self-serve buyer who is not being coached is NOT a client (row exists, no relationship)", () => {
  // SYSTEM buyers get a clients row with origin 'system'; if they are not active/paused and not billed for coaching, they may enroll.
  if (rel({ status: "invited", subscription_status: null })) throw new Error("system buyer, invited, must be false");
});

Deno.test("the audience gate uses the predicate: archived former client admitted to non_clients_only, active client refused", () => {
  const ch = { ...published, audience: "non_clients_only" };
  const former = enrollDecision({ challenge: ch, isClient: rel({ status: "archived" }) });
  if (!former.ok) throw new Error("archived former client must be admitted: " + JSON.stringify(former));
  const active = enrollDecision({ challenge: ch, isClient: rel({ status: "active" }) });
  if (active.ok || active.status !== 403) throw new Error("active client must be refused: " + JSON.stringify(active));
  const paused = enrollDecision({ challenge: ch, isClient: rel({ status: "paused" }) });
  if (paused.ok) throw new Error("paused client must be refused");
});

Deno.test("clients_only keeps working with the predicate: archived former client is refused, active admitted", () => {
  const ch = { ...published, audience: "clients_only" };
  const former = enrollDecision({ challenge: ch, isClient: rel({ status: "archived" }) });
  if (former.ok) throw new Error("archived is not a current client for clients_only");
  const active = enrollDecision({ challenge: ch, isClient: rel({ status: "active" }) });
  if (!active.ok) throw new Error("active must be admitted");
});
