// Behavioral tests for the check-in v2 generator core. Pure-function rules are
// tested directly; assessCheckin() is tested against a recorded fake db plus a
// stubbed Anthropic fetch call — not a live-database or live-API integration test.
import { assessCheckin, buildSystemPrompt, buildUserPrompt, daysOut, validateResult } from "./checkinAssess.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// --------------------------------------------------------------------------
// Pure functions
// --------------------------------------------------------------------------

Deno.test("validateResult: a proposed tag with no evidence is rejected — no evidence, no tag", () => {
  let threw = "";
  try {
    validateResult({ summary: "x", excluded_fields: [], proposed_tag: "M02", proposed_evidence: [], no_tag_reason: null });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("evidence"), `expected an evidence-related failure, got: ${threw}`);
});

Deno.test("validateResult: declining without a no_tag_reason is rejected", () => {
  let threw = "";
  try {
    validateResult({ summary: "x", excluded_fields: [], proposed_tag: null, proposed_evidence: [], no_tag_reason: null });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("no_tag_reason"), `expected a no_tag_reason failure, got: ${threw}`);
});

Deno.test("validateResult: an invalid stage id is rejected", () => {
  let threw = "";
  try {
    validateResult({ summary: "x", excluded_fields: [], proposed_tag: "M09", proposed_evidence: [{ field_key: "a", quote_or_value: "b", why: "c" }], no_tag_reason: null });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("M09"), `expected the bad stage id in the error, got: ${threw}`);
});

Deno.test("validateResult: an empty summary is rejected", () => {
  let threw = "";
  try {
    validateResult({ summary: "  ", excluded_fields: [], proposed_tag: null, proposed_evidence: [], no_tag_reason: "insufficient_evidence" });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("summary"), `expected an empty-summary failure, got: ${threw}`);
});

Deno.test("validateResult: a well-formed decline passes", () => {
  validateResult({ summary: "Slept 5.1h, energy 2/5. No text answers this week.", excluded_fields: [], proposed_tag: null, proposed_evidence: [], no_tag_reason: "requires_history" });
});

Deno.test("validateResult: a well-formed proposal with evidence passes", () => {
  validateResult({
    summary: "Sleep 4.5h, zero of four sessions.",
    excluded_fields: [{ field_key: "steps_avg", reason: "blank" }],
    proposed_tag: "M02",
    proposed_evidence: [{ field_key: "talked_out_of", quote_or_value: "figured one week off wouldn't matter", why: "states his own interpretation of missing sessions" }],
    no_tag_reason: null,
  });
});

Deno.test("daysOut: null show_date returns null, not zero or a guess", () => {
  assert(daysOut(null) === null, "a missing show_date must never be treated as zero days out");
});

Deno.test("daysOut: a future date returns a positive count", () => {
  const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const d = daysOut(future);
  assert(d !== null && d >= 9 && d <= 10, `expected ~10 days out, got ${d}`);
});

Deno.test("prompts: the system prompt states the no-evidence-no-tag rule and the client_type gate", () => {
  const p = buildSystemPrompt();
  assert(p.includes("No evidence, no tag"), "must state the core evidence rule");
  assert(p.includes("client_type is null"), "must state the unclassified-client gate");
  assert(p.includes("Word-matching is never evidence"), "must state the word-matching rule");
});

Deno.test("prompts: the user prompt names fields the tenant never asked, separately from blank ones", () => {
  const prompt = buildUserPrompt({
    checkin: { submitted_at: "2026-08-20T00:00:00Z", weight: 180, answers: { sleep_avg_hrs: 6 } },
    tenantQuestions: [{ id: "sleep_avg_hrs", text: "Sleep" }],
    client: { client_type: "lifestyle" },
    priorCheckins: [],
    corrections: [],
  });
  assert(prompt.includes("sleep_avg_hrs"), "must include the configured question set for not_asked detection");
  assert(prompt.includes("none. This may be the first check-in"), "must state plainly when there is no history, not omit it");
});

// --------------------------------------------------------------------------
// assessCheckin — fake db + stubbed fetch
// --------------------------------------------------------------------------

const TENANT_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHECKIN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function fakeDb(rows: Record<string, any>) {
  const upserts: any[] = [];
  const db = {
    from(table: string) {
      const chain: any = {
        select() { return chain; },
        eq() { return chain; },
        neq() { return chain; },
        in() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle() { return Promise.resolve({ data: rows[table]?.single ?? null, error: null }); },
        upsert(row: unknown, opts: unknown) {
          upserts.push({ table, row, opts });
          return { then: (res: any) => res({ error: null }) };
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve({ data: rows[table]?.list ?? [], error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
  return { db, upserts };
}

const baseRows = {
  checkins: { single: { id: CHECKIN, tenant_id: TENANT_OWNER, client_id: CLIENT, submitted_at: "2026-08-20T00:00:00Z", weight: 178, answers: { sleep_avg_hrs: 5 } }, list: [] },
  tenants: { single: { slug: "owner" } },
  checkin_assessments: { single: null, list: [] },
  clients: { single: { id: CLIENT, client_type: "lifestyle", show_date: null } },
  tenant_config: { single: { checkin_fields: { questions: [{ id: "sleep_avg_hrs", text: "Sleep" }] } } },
  checkin_tag_corrections: { list: [] },
};

function stubFetch(response: unknown, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify(response), { status }))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

Deno.test("assessCheckin: skips a tenant other than owner — scope is not silently ignored", async () => {
  const { db, upserts } = fakeDb({ ...baseRows, tenants: { single: { slug: "outside-coach" } }, checkins: { single: { ...baseRows.checkins.single, tenant_id: TENANT_OTHER }, list: [] } });
  const result = await assessCheckin(db as any, CHECKIN) as any;
  assert(result.skipped?.includes("owner-only"), `expected the owner-only skip reason, got: ${JSON.stringify(result)}`);
  assert(upserts.length === 0, "no assessment may be written for a non-owner tenant");
});

Deno.test("assessCheckin: never regenerates over a coach's confirmed tag", async () => {
  const restore = stubFetch({ content: [] }); // would blow up if called — proves it never gets there
  try {
    const { db, upserts } = fakeDb({ ...baseRows, checkin_assessments: { single: { id: "x", confirmed_tag: "M02" }, list: [] } });
    const result = await assessCheckin(db as any, CHECKIN) as any;
    assert(result.skipped?.includes("confirmed"), `expected the already-confirmed skip reason, got: ${JSON.stringify(result)}`);
    assert(upserts.length === 0, "a confirmed row must never be overwritten by regeneration");
  } finally { restore(); }
});

Deno.test("assessCheckin: happy path writes summary_model, never writes confirmed_tag, keys off checkin_id", async () => {
  Deno.env.set("ANTHROPIC_API_KEY", "test-key-not-real");
  const restore = stubFetch({
    content: [{
      type: "tool_use",
      name: "record_assessment",
      input: {
        summary: "Sleep 5.0h. No other fields answered.",
        excluded_fields: [{ field_key: "sessions", reason: "not_asked" }],
        proposed_tag: null,
        proposed_evidence: [],
        no_tag_reason: "insufficient_evidence",
      },
    }],
  });
  try {
    const { db, upserts } = fakeDb(baseRows);
    const result = await assessCheckin(db as any, CHECKIN) as any;
    assert(result.ok === true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert(upserts.length === 1, "must write exactly one assessment row");
    const row = upserts[0].row;
    assert(row.checkin_id === CHECKIN, "row must key off the checkin id");
    assert(row.tenant_id === TENANT_OWNER, "row must carry the tenant id");
    assert(row.client_id === CLIENT, "row must carry the client id");
    assert(row.summary_model, "row must record which model wrote the summary");
    assert(!("confirmed_tag" in row), "generator must never write confirmed_tag — that is coach-only");
    assert(!("confirmed_by" in row), "generator must never write confirmed_by");
    assert(upserts[0].opts?.onConflict === "checkin_id", "must upsert on checkin_id, matching the table's unique constraint");
  } finally { restore(); }
});
