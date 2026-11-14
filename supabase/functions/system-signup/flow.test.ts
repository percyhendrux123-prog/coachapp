// Run: deno test --allow-read supabase/functions/system-signup/flow.test.ts
import { clientIp, keyedHash, parseCap, runSignup, safeOrigin, type Deps, type Gate } from "./flow.ts";

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

// An in-memory gate with the SQL rules (system_signup_gate), so the limits are exercised end to end.
function world(opts: { existing?: string[]; cap?: number; sendFails?: boolean } = {}) {
  const attempts: { e: string; ip: string; d: string; id: string }[] = [];
  const clients = new Map<string, { id: string; submitted: boolean }>();
  for (const e of opts.existing ?? []) clients.set(e, { id: "c-" + e, submitted: true });
  const sent: { to: string; kind: string; token?: string }[] = [];
  const accounts = new Set<string>();
  let n = 0;
  const deps: Deps = {
    hash: (v) => keyedHash("k", v),
    gate: async (eh, ih, cap) => {
      const inHourIp = attempts.filter((a) => a.ip === ih).length;
      const recent = attempts.some((a) => a.e === eh && (a.d === "ok" || a.d === "sent"));
      const day = attempts.filter((a) => a.d === "ok" || a.d === "sent").length;
      const d: Gate["decision"] = inHourIp >= 5 ? "ip_limited" : recent ? "email_recent" : day >= cap ? "paused" : "ok";
      const id = "att-" + (++n);
      attempts.push({ e: eh, ip: ih, d, id });
      return { decision: d, attempt_id: id };
    },
    provision: async (email) => {
      const c = clients.get(email);
      if (c?.submitted) return { kind: "existing", client_id: c.id, new_client: false };
      if (c) return { kind: "intake", client_id: c.id, intake_token: "tok-" + c.id, new_client: false };
      const nc = { id: "c-" + email, submitted: false }; clients.set(email, nc);
      return { kind: "intake", client_id: nc.id, intake_token: "tok-" + nc.id, new_client: true };
    },
    ensureAccount: async (e) => { if (accounts.has(e)) return "existed"; accounts.add(e); return "created"; },
    saveSource: async () => {},
    sendIntake: async (to, _c, token) => { if (opts.sendFails) return "Resend 500"; sent.push({ to, kind: "intake", token }); return null; },
    sendSignIn: async (to) => { if (opts.sendFails) return "Resend 500"; sent.push({ to, kind: "signin" }); return null; },
    mark: async (id, d) => { const a = attempts.find((x) => x.id === id); if (a) a.d = d; },
  };
  return { deps, sent, attempts, clients };
}
const call = (w: ReturnType<typeof world>, email: string, ip = "1.1.1.1", cap = 50) => runSignup(w.deps, { email, ip, cap });

Deno.test("same answer for a new and an existing address; no token in any response", async () => {
  const w = world({ existing: ["old@example.com"] });
  const a = await call(w, "new@example.com");
  const b = await call(w, "old@example.com", "2.2.2.2");
  eq(a, b, "identical answers");
  eq(a, { status: 200, body: { ok: true } }, "ok");
  if (/tok-|token/.test(JSON.stringify([a, b]))) throw new Error("a token leaked into a response");
  eq(w.sent.map((s) => s.kind), ["intake", "signin"], "the new address gets the intake link, the existing one a sign-in email");
});
Deno.test("same address: one email per 24 h, later tries get the same answer and nothing is sent", async () => {
  const w = world();
  await call(w, "a@example.com");
  const again = await call(w, "A@Example.com ", "9.9.9.9");
  eq(again, { status: 200, body: { ok: true } }, "same answer");
  eq(w.sent.length, 1, "one email");
});
Deno.test("per network address: 5 attempts an hour, then 429", async () => {
  const w = world();
  for (let i = 0; i < 5; i++) eq((await call(w, `p${i}@example.com`, "3.3.3.3")).status, 200, "try " + i);
  eq((await call(w, "p6@example.com", "3.3.3.3")).status, 429, "sixth refused");
  eq(w.sent.length, 5, "nothing sent on the refused try");
});
Deno.test("daily cap: over it the page says paused and nothing is sent", async () => {
  const w = world();
  eq((await call(w, "x1@example.com", "4.0.0.1", 2)).status, 200, "1");
  eq((await call(w, "x2@example.com", "4.0.0.2", 2)).status, 200, "2");
  eq(await call(w, "x3@example.com", "4.0.0.3", 2), { status: 200, body: { paused: true } }, "paused");
  eq(w.sent.length, 2, "two sent");
  eq((await call(w, "x4@example.com", "4.0.0.4", 0)).body, { paused: true }, "cap 0 pauses everything");
});
Deno.test("a failed send is reported and does not lock the address out", async () => {
  const w = world({ sendFails: true });
  eq((await call(w, "f@example.com")).status, 502, "502");
  eq(w.attempts[0].d, "send_failed", "marked");
  const w2 = world();
  w2.attempts.push(...w.attempts);
  eq((await call(w2, "f@example.com", "5.5.5.5")).status, 200, "retry allowed");
  eq(w2.sent.length, 1, "sent on retry");
});
Deno.test("provision is idempotent: a second signup reuses the client and the token", async () => {
  const w = world();
  const first = await w.deps.provision("i@example.com");
  const second = await w.deps.provision("i@example.com");
  eq([first.client_id, (first as any).intake_token], [second.client_id, (second as any).intake_token], "same client and token");
});
Deno.test("bad input and origins", async () => {
  eq((await call(world(), "not-an-email")).status, 400, "bad email");
  eq(safeOrigin("https://evil.example.net", ["app.example.com"]), null, "foreign origin refused");
  eq(safeOrigin("https://app.example.com", ["app.example.com"]), "https://app.example.com", "allowed");
  eq(safeOrigin("https://x.app.example.com", ["app.example.com"]), "https://x.app.example.com", "subdomain");
  eq(safeOrigin("https://app.example.com.evil.net", ["app.example.com"]), null, "suffix trick refused");
  eq(safeOrigin("", ["app.example.com"]), null, "no origin");
});
Deno.test("gate failure fails closed", async () => {
  const w = world();
  w.deps.gate = async () => { throw new Error("db down"); };
  eq((await call(w, "g@example.com")).status, 503, "503");
  eq(w.sent.length, 0, "nothing sent");
});
Deno.test("cap parsing and IP reading", () => {
  eq([parseCap(undefined), parseCap(""), parseCap("12"), parseCap("0"), parseCap("-1"), parseCap("abc"), parseCap("2.5")], [50, 50, 12, 0, 50, 50, 50], "cap");
  eq(clientIp(new Headers({ "x-forwarded-for": "7.7.7.7, 10.0.0.1" })), "7.7.7.7", "first hop");
  eq(clientIp(new Headers()), "unknown", "shared bucket");
});
