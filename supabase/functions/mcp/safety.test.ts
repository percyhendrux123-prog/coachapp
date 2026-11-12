import {
  AUDIT_ERROR_MAX,
  canUseTool,
  hiddenWithoutCoach,
  mealLibraryVisibilityFilter,
  summarizeAuditArguments,
  UUID_PATTERN,
  validateToolArguments,
} from "./safety.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

Deno.test("read scopes cannot call write tools", () => {
  assert(canUseTool("coach", "read", false), "coach reads should remain available");
  assert(!canUseTool("coach", "read", true), "coach read token must not write");
  assert(canUseTool("coach", "read_write", true), "legacy coach write token should remain represented until revoked");
  assert(!canUseTool("client", "read", true), "client read token must not write");
  assert(canUseTool("client", "comms", true), "client relay scope should retain its curated writes");
});

Deno.test("coach-relay tools are hidden on a coachless (self-serve) tenant only", () => {
  const eq = (a: unknown, b: unknown, m: string) => { if (a !== b) throw new Error(m); };
  eq(hiddenWithoutCoach(true, true), true, "self-serve hides a needs-coach tool");
  eq(hiddenWithoutCoach(true, false), false, "self-serve keeps every other tool");
  eq(hiddenWithoutCoach(true, undefined), false, "an unmarked tool is never hidden");
  eq(hiddenWithoutCoach(false, true), false, "a coached tenant keeps message_coach / flag_issue");
});

Deno.test("owner ⊇ comms; comms cannot reach owner tools; coach unchanged", () => {
  const eq = (a: unknown, b: unknown, m: string) => { if (a !== b) throw new Error(m); };
  eq(canUseTool("client", "read", true, "comms"), false, "read cannot write");
  eq(canUseTool("client", "comms", true, "comms"), true, "comms writes comms");
  eq(canUseTool("client", "comms", true, "owner"), false, "comms cannot reach owner tools");
  eq(canUseTool("client", "owner", true, "comms"), true, "owner can use comms tools");
  eq(canUseTool("client", "owner", true, "owner"), true, "owner uses owner tools");
  eq(canUseTool("client", "owner", true, undefined), true, "owner uses untagged client writes");
  eq(canUseTool("coach", "read_write", true, "owner"), false, "coach tokens never use owner tools");
  eq(canUseTool("coach", "read_write", true, undefined), true, "coach read_write unchanged");
  eq(canUseTool("client", "owner", false, undefined), true, "reads always allowed");
});

Deno.test("meal filter includes own custom meals only when clientId given", () => {
  const t = "11111111-1111-4111-8111-111111111111", c = "22222222-2222-4222-8222-222222222222";
  if (mealLibraryVisibilityFilter(t) !== `tenant_id.is.null,and(tenant_id.eq.${t},owner_client_id.is.null)`) throw new Error("tenant-only filter changed");
  if (mealLibraryVisibilityFilter(t, c) !== `tenant_id.is.null,and(tenant_id.eq.${t},owner_client_id.is.null),owner_client_id.eq.${c}`) throw new Error("client filter");
});

Deno.test("argument validation rejects extra fields and malformed ids", () => {
  const schema = {
    type: "object",
    properties: { client_id: { type: "string", pattern: UUID_PATTERN }, body: { type: "string", minLength: 1, maxLength: 2000 } },
    required: ["client_id", "body"],
    additionalProperties: false,
  };
  assert(validateToolArguments(schema, { client_id: CLIENT_ID, body: "hello" }) === null, "valid arguments should pass");
  assert(validateToolArguments(schema, { client_id: "private narrative injected as an id", body: "hello" })?.includes("invalid format"), "malformed id must fail");
  assert(validateToolArguments(schema, { client_id: CLIENT_ID, body: "hello", private_notes: "secret" })?.includes("not allowed"), "unknown field must fail");
});

Deno.test("argument validation enforces union types used by workout logging", () => {
  const workoutSchema = {
    type: "object",
    properties: {
      sets: {
        type: "array", minItems: 1, maxItems: 60,
        items: {
          type: "object",
          properties: {
            exercise_id: { type: "string", pattern: UUID_PATTERN },
            set_index: { type: "integer", minimum: 0 },
            weight: { type: ["number", "null"] },
            reps: { type: ["integer", "null"] },
            done: { type: "boolean" },
          },
          required: ["exercise_id", "set_index"],
          additionalProperties: false,
        },
      },
    },
    required: ["sets"],
    additionalProperties: false,
  };
  const valid = { sets: [{ exercise_id: CLIENT_ID, set_index: 0, weight: 225, reps: null, done: true }] };
  assert(validateToolArguments(workoutSchema, valid) === null, "actual workout shape should pass");
  const objectWeight = { sets: [{ ...valid.sets[0], weight: { private_weight_note: "heavy" } }] };
  assert(validateToolArguments(workoutSchema, objectWeight)?.includes("must match one of"), "object weight must fail number|null");
  const booleanReps = { sets: [{ ...valid.sets[0], reps: true }] };
  assert(validateToolArguments(workoutSchema, booleanReps)?.includes("must match one of"), "boolean reps must fail integer|null");
});

Deno.test("argument validation fails closed for missing or unknown schema types", () => {
  assert(validateToolArguments({}, "anything")?.includes("missing a type"), "missing type must fail closed");
  assert(validateToolArguments({ type: "bogus" }, { private: true })?.includes("unsupported"), "unknown type must fail closed");
});

Deno.test("audit summary cannot retain free text or caller-controlled keys", () => {
  const summary = summarizeAuditArguments("send_message", {
    client_id: "private narrative injected as an id",
    body: "sensitive coaching message",
    private_narrative_key: "secret",
    nested: { "sensitive property name": true },
  }, false);
  const serialized = JSON.stringify(summary);
  assert(serialized === '{"ok":false}', `hostile text leaked into audit: ${serialized}`);

  const valid = summarizeAuditArguments("send_message", { client_id: CLIENT_ID, body: "not retained" }, true);
  assert(valid.client_id === CLIENT_ID, "valid entity id should be retained");
  assert(!JSON.stringify(valid).includes("not retained"), "message body must not be retained");
});

Deno.test("program audits retain counts but no labels or exercise names", () => {
  const summary = summarizeAuditArguments("create_program", {
    name: "private program name",
    structure: { days: [{ label: "private day", groups: [{ exercises: [{ name: "private exercise" }] }] }] },
  }, true);
  assert(JSON.stringify(summary) === '{"ok":true,"structure":{"days":1,"exercises":1}}', "only structural counts should survive");
});

Deno.test("a failed tool call records WHY it failed, and never echoes caller free text", () => {
  const failed = summarizeAuditArguments(
    "get_support_queue",
    { stale_after_days: 30 },
    false,
    "invalid arguments: arguments.stale_after_days is above the maximum",
  );
  assert(failed.ok === false, "failure must still be recorded as a failure");
  assert(
    failed.error === "invalid arguments: arguments.stale_after_days is above the maximum",
    "the server-generated reason must survive into the audit row",
  );
  assert(failed.stale_after_days === 30, "the structural argument is still recorded alongside it");

  const ok = summarizeAuditArguments("get_support_queue", { stale_after_days: 7 }, true, "ignored");
  assert(!("error" in ok), "a successful call must not carry an error field");

  const longReason = summarizeAuditArguments("send_message", {}, false, "x".repeat(1000));
  assert(String(longReason.error).length === AUDIT_ERROR_MAX, "the reason is capped, not unbounded");

  const notAString = summarizeAuditArguments("send_message", { body: "private client text" }, false, { leak: true });
  assert(!("error" in notAString), "a non-string reason is dropped rather than serialized");
  assert(!("body" in notAString), "caller free text is never recorded");
});

Deno.test("challenge and client-status audits retain structural fields but no titles, slugs, or free text", () => {
  const created = summarizeAuditArguments("create_challenge", {
    title: "private title", slug: "private-slug", description: "private description",
    duration_days: 7, standards: [{ title: "a" }, { title: "b" }],
  }, true);
  assert(JSON.stringify(created) === '{"ok":true,"duration_days":7,"standards_count":2}', `challenge creation audit leaked a field: ${JSON.stringify(created)}`);

  const published = summarizeAuditArguments("publish_challenge", { challenge_id: CLIENT_ID }, true);
  assert(published.challenge_id === CLIENT_ID, "challenge_id should be retained on publish");

  const enrolled = summarizeAuditArguments("enroll_client_in_challenge", { challenge_id: CLIENT_ID, client_id: CLIENT_ID }, true);
  assert(enrolled.challenge_id === CLIENT_ID && enrolled.client_id === CLIENT_ID, "both ids should be retained on enrollment");

  const status = summarizeAuditArguments("update_client_status", {
    client_id: CLIENT_ID, status: "archived", pause_resume_date: "private date reasoning",
  }, true);
  assert(JSON.stringify(status) === `{"ok":true,"client_id":"${CLIENT_ID}"}`, `status change audit leaked a field: ${JSON.stringify(status)}`);
});

Deno.test("meal filter allows only shared, the authenticated tenant's shared meals, or the client's own", () => {
  const filter = mealLibraryVisibilityFilter(CLIENT_ID);
  assert(filter === `tenant_id.is.null,and(tenant_id.eq.${CLIENT_ID},owner_client_id.is.null)`, "unexpected meal visibility predicate");
  let failed = false;
  try { mealLibraryVisibilityFilter("not-a-tenant"); } catch { failed = true; }
  assert(failed, "invalid tenant id must fail closed");
});

Deno.test("connector entry points require the supported prefix and platform tools use the shared owner identity", async () => {
  const source = await Deno.readTextFile("supabase/functions/mcp/index.ts");
  const importer = await Deno.readTextFile("supabase/functions/trainerize-import/index.ts");
  assert(source.includes('const SERVER_INFO = { name: "coachapp",'), "server identity must remain neutral");
  assert(source.includes('import { OWNER_TENANT_SLUG } from "../_shared/owner.ts";'), "owner identity must come from the shared module");
  assert(source.includes('data.slug !== OWNER_TENANT_SLUG'), "platform tools must compare the shared owner identity");
  assert(/async function authenticate[\s\S]*?if \(!raw\.trim\(\)\.startsWith\("coach_mcp_"\)\) return null;/.test(source), "direct authentication must reject unsupported connector prefixes before lookup");
  assert(/async function connectorTokenValid[\s\S]*?if \(!raw\.trim\(\)\.startsWith\("coach_mcp_"\)\) return false;/.test(source), "OAuth authorization must reject unsupported connector prefixes before lookup");
  assert(importer.includes('if (bearer.startsWith("coach_mcp_")) {'), "import connector authentication must accept only the supported prefix");
});

Deno.test("service-role meal search and plan hydration both reapply the tenant boundary", async () => {
  const source = await Deno.readTextFile("supabase/functions/mcp/index.ts");
  const boundaryUses = source.match(/\.or\(mealLibraryVisibilityFilter\(ctx\.tenantId, ctx\.clientId\)\)/g) ?? [];
  const publishedUses = source.match(/\.eq\("status", "published"\)/g) ?? [];
  assert(boundaryUses.length >= 2, "meal search and hydration must both apply tenant visibility");
  assert(publishedUses.length >= 2, "meal search and hydration must both require published status");
});

// Coach tokens permit read/read_write; the policy migration owns the guard tested here. Client
// tokens still cannot be read_write (table CHECK), and identity/revocation stay locked.
Deno.test("migration limits coach token creation to read/read_write while preserving immutability and revocation", async () => {
  const sql = await Deno.readTextFile("supabase/migrations/20260910073500_connector_coach_tokens_allow_read_write.sql");
  const baseline = await Deno.readTextFile("supabase/migrations/00000000000000_initial_schema.sql");
  const table = baseline.match(/CREATE TABLE public\.connector_tokens \(([\s\S]*?)\n\);/)?.[1] ?? "";
  const actualColumns = new Set([...table.matchAll(/^\s*([a-z_]+)\s+/gm)].map((match) => match[1]));
  assert(actualColumns.size > 0, "connector_tokens columns must be extracted from the initial schema");
  assert(sql.includes("scope in ('read', 'read_write')"), "coach insert policy must allow exactly read and read_write");
  assert(sql.includes("kind = 'coach'"), "coach insert policy must still pin kind = coach");
  assert(sql.includes("created_by = auth.uid()"), "coach insert policy must still pin created_by to the caller");
  assert(sql.includes("TG_OP = 'INSERT'"), "trigger must still gate coach-session inserts");
  assert(sql.includes("new.scope not in ('read', 'read_write')"), "trigger must reject any other scope for a coach session");
  for (const field of ["id", "tenant_id", "created_by", "kind", "scope", "client_id", "token_hash", "created_at"]) {
    assert(actualColumns.has(field), `${field} must exist in the initial schema`);
    assert(sql.includes(`new.${field} is distinct from old.${field}`), `${field} must be immutable`);
  }
  for (const reference of [...sql.matchAll(/\b(?:new|old)\.([a-z_]+)/g)].map((match) => match[1])) {
    assert(actualColumns.has(reference), `migration references nonexistent connector_tokens column: ${reference}`);
  }
  assert(sql.includes("old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at"), "revoked tokens must not be reactivated or rekeyed");
});
