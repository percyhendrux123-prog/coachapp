// Behavioral tests for markThreadReadCore with an injected fake db.
// These are unit tests against a recorded query surface — NOT a live-database
// integration test. They prove ordering, scoping, identity validation, and
// failure propagation at the query-construction level.
import { markThreadReadCore } from "./markThreadRead.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const TENANT = "22222222-2222-4222-8222-222222222222";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const COACH_USER = "33333333-3333-4333-8333-333333333333";

type Call = { table: string; op: string; args: unknown[]; filters: Array<[string, ...unknown[]]> };

// Minimal recording fake of the supabase-js query surface the core uses.
function fakeDb(opts: {
  coachProfileFound?: boolean;
  profileError?: string | null;
  upsertError?: string | null;
  updateError?: string | null;
  updatedRows?: number;
} = {}) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, op: "", args: [], filters: [] };
      calls.push(call);
      const chain: any = {
        select(...a: unknown[]) { call.args.push(["select", ...a]); return chain; },
        upsert(...a: unknown[]) { call.op = "upsert"; call.args.push(["upsert", ...a]); return chain; },
        update(...a: unknown[]) { call.op = "update"; call.args.push(["update", ...a]); return chain; },
        eq(...a: unknown[]) { call.filters.push(["eq", ...a]); return chain; },
        is(...a: unknown[]) { call.filters.push(["is", ...a]); return chain; },
        maybeSingle() {
          call.op = call.op || "select";
          if (table === "profiles") {
            if (opts.profileError) return Promise.resolve({ data: null, error: { message: opts.profileError } });
            return Promise.resolve({
              data: opts.coachProfileFound === false ? null : { user_id: COACH_USER, role: "coach" },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          // Awaiting the chain settles the upsert/update.
          if (call.op === "upsert") {
            return Promise.resolve({ error: opts.upsertError ? { message: opts.upsertError } : null }).then(resolve, reject);
          }
          if (call.op === "update") {
            return Promise.resolve({
              data: opts.updateError ? null : Array.from({ length: opts.updatedRows ?? 0 }, (_, i) => ({ id: `m${i}` })),
              error: opts.updateError ? { message: opts.updateError } : null,
            }).then(resolve, reject);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return { db, calls };
}

const coachCtx = { tokenId: "t", tenantId: TENANT, kind: "coach" as const, clientId: null, scope: "read_write", createdBy: COACH_USER };

Deno.test("rejects a client-kind context outright", async () => {
  const { db, calls } = fakeDb();
  let threw = "";
  try { await markThreadReadCore(db as any, { ...coachCtx, kind: "client" as const, clientId: CLIENT }, CLIENT); }
  catch (e) { threw = (e as Error).message; }
  assert(threw.includes("coach"), `client token must be rejected, got: ${threw}`);
  assert(calls.length === 0, "no queries may run for a rejected client token");
});

Deno.test("rejects a token with no creator identity", async () => {
  const { db, calls } = fakeDb();
  let threw = "";
  try { await markThreadReadCore(db as any, { ...coachCtx, createdBy: null }, CLIENT); }
  catch (e) { threw = (e as Error).message; }
  assert(threw.length > 0, "missing created_by must fail");
  assert(calls.length === 0, "no queries may run without a reader identity");
});

Deno.test("rejects a creator that is not a coach profile in this tenant", async () => {
  const { db, calls } = fakeDb({ coachProfileFound: false });
  let threw = "";
  try { await markThreadReadCore(db as any, coachCtx, CLIENT); }
  catch (e) { threw = (e as Error).message; }
  assert(threw.length > 0, "non-coach creator must fail");
  const profileCall = calls.find((c) => c.table === "profiles");
  assert(profileCall, "must have queried profiles to validate the reader");
  assert(profileCall!.filters.some((f) => f[0] === "eq" && f[1] === "tenant_id" && f[2] === TENANT), "profile lookup must pin tenant_id");
  assert(profileCall!.filters.some((f) => f[0] === "eq" && f[1] === "user_id" && f[2] === COACH_USER), "profile lookup must pin the creator user id");
  assert(profileCall!.filters.some((f) => f[0] === "eq" && f[1] === "role" && f[2] === "coach"), "profile lookup must require the coach role");
  assert(!calls.some((c) => c.table === "message_reads"), "no read-pointer write may happen for an invalid reader");
  assert(!calls.some((c) => c.table === "messages"), "no read_at stamp may happen for an invalid reader");
});

Deno.test("happy path: upserts the read pointer then stamps read_at, both tenant/client pinned", async () => {
  const { db, calls } = fakeDb({ updatedRows: 3 });
  const result = await markThreadReadCore(db as any, coachCtx, CLIENT) as any;
  const order = calls.map((c) => c.table);
  assert(order.join(",") === "profiles,message_reads,messages", `expected profiles→message_reads→messages, got ${order.join(",")}`);

  const upsert = calls.find((c) => c.table === "message_reads")!;
  const upsertArgs = upsert.args.find((a: any) => a[0] === "upsert") as any[];
  const row = upsertArgs[1];
  assert(row.tenant_id === TENANT, "message_reads row must carry the token tenant");
  assert(row.client_id === CLIENT, "message_reads row must carry the requested client");
  assert(row.reader_user_id === COACH_USER, "reader_user_id must be the connector token creator");
  assert(typeof row.last_read_at === "string", "last_read_at must be an explicit timestamp");
  const upsertOpts = upsertArgs[2];
  assert(upsertOpts?.onConflict === "tenant_id,client_id,reader_user_id", "upsert must target the message_reads primary key");

  const update = calls.find((c) => c.table === "messages")!;
  assert(update.filters.some((f) => f[0] === "eq" && f[1] === "tenant_id" && f[2] === TENANT), "read_at update must pin tenant_id");
  assert(update.filters.some((f) => f[0] === "eq" && f[1] === "client_id" && f[2] === CLIENT), "read_at update must pin client_id");
  assert(update.filters.some((f) => f[0] === "eq" && f[1] === "sender_role" && f[2] === "client"), "read_at update must only touch client-sender rows");
  assert(update.filters.some((f) => f[0] === "is" && f[1] === "read_at" && f[2] === null), "read_at update must only touch currently-unread rows — later inbound stays unread");

  assert(result.marked === true, "must report marked");
  assert(result.stamped_messages === 3, "must report how many rows were stamped");
});

Deno.test("read-pointer failure throws and never attempts the read_at stamp", async () => {
  const { db, calls } = fakeDb({ upsertError: "rls denied" });
  let threw = "";
  try { await markThreadReadCore(db as any, coachCtx, CLIENT); }
  catch (e) { threw = (e as Error).message; }
  assert(threw.includes("rls denied"), "upsert failure must surface, not be swallowed");
  assert(!calls.some((c) => c.table === "messages"), "messages update must not run after a failed pointer write");
});

Deno.test("read_at stamp failure throws instead of being swallowed", async () => {
  const { db } = fakeDb({ updateError: "network down" });
  let threw = "";
  try { await markThreadReadCore(db as any, coachCtx, CLIENT); }
  catch (e) { threw = (e as Error).message; }
  assert(threw.includes("network down"), "update failure must surface, not be swallowed");
});

Deno.test("profile lookup failure is an honest error, not a silent pass", async () => {
  const { db, calls } = fakeDb({ profileError: "timeout" });
  let threw = "";
  try { await markThreadReadCore(db as any, coachCtx, CLIENT); }
  catch (e) { threw = (e as Error).message; }
  assert(threw.length > 0, "a failed identity read must fail the mark");
  assert(!calls.some((c) => c.table === "message_reads"), "no write on unverified identity");
});
