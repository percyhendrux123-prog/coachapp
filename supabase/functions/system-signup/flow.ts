// system-signup, the testable half. index.ts wires the database, auth and email calls in.
//
// Rules (all fail closed):
//   * the browser gets the same answer for a new address and one that already has a plan —
//     { ok: true } — so the form cannot be used to find out who has an account;
//   * the intake link (its token) is only ever in the email, never in a response;
//   * same address: at most one email per 24 h; later tries get { ok: true } and nothing is sent;
//   * one network address: 5 attempts per hour; over it, 429;
//   * the daily cap on emails sent (SYSTEM_SIGNUP_DAILY_CAP, default 50); over it { paused: true }.
export const DEFAULT_DAILY_CAP = 50;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Same allow-list rule the old checkout used. localhost is for local runs only.
export function safeOrigin(origin: string, allowed: string[]): string | null {
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return u.origin;
    return allowed.some((d) => u.hostname === d || u.hostname.endsWith("." + d)) ? u.origin : null;
  } catch { return null; }
}

export function parseCap(raw: string | undefined | null): number {
  if (raw == null || String(raw).trim() === "") return DEFAULT_DAILY_CAP;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

export function normalizeEmail(raw: unknown): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

// The caller's network address as the platform reports it. A missing header falls into one
// shared bucket, so it is limited too.
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  return first || headers.get("cf-connecting-ip") || headers.get("x-real-ip") || "unknown";
}

export async function keyedHash(key: string, value: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key || "system-signup"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Gate = { decision: "ok" | "email_recent" | "ip_limited" | "paused"; attempt_id: string };
export type Provisioned =
  | { kind: "intake"; client_id: string; intake_token: string; new_client: boolean }
  | { kind: "existing"; client_id: string; new_client: false };

export type Deps = {
  gate: (emailHash: string, ipHash: string, cap: number) => Promise<Gate>;
  provision: (email: string) => Promise<Provisioned>;
  ensureAccount: (email: string) => Promise<"created" | "existed" | "failed">;
  saveSource: (clientId: string) => Promise<void>;
  sendIntake: (email: string, clientId: string, token: string) => Promise<string | null>; // null = sent
  sendSignIn: (email: string, clientId: string) => Promise<string | null>;
  mark: (attemptId: string, decision: "sent" | "send_failed" | "failed") => Promise<void>;
  hash: (value: string) => Promise<string>;
};

export type Out = { status: number; body: Record<string, unknown> };
const OK: Out = { status: 200, body: { ok: true } };

export async function runSignup(deps: Deps, input: { email: unknown; ip: string; cap: number }): Promise<Out> {
  const email = normalizeEmail(input.email);
  if (!email) return { status: 400, body: { error: "a valid email is required" } };

  let gate: Gate;
  try { gate = await deps.gate(await deps.hash("email:" + email), await deps.hash("ip:" + input.ip), input.cap); }
  catch { return { status: 503, body: { error: "Signup is unavailable right now. Try again later." } }; }
  if (gate.decision === "ip_limited") return { status: 429, body: { error: "Too many tries from here. Try again in an hour." } };
  if (gate.decision === "paused") return { status: 200, body: { paused: true } };
  if (gate.decision === "email_recent") return OK; // same answer, nothing sent
  if (gate.decision !== "ok") return { status: 503, body: { error: "Signup is unavailable right now. Try again later." } };

  let prov: Provisioned;
  try { prov = await deps.provision(email); }
  catch { await deps.mark(gate.attempt_id, "failed"); return { status: 500, body: { error: "Could not start your plan. Try again in a few minutes." } }; }

  // The sign-in account: unconfirmed, no password. A failure here is not fatal — the person
  // can still sign in with an email code later, and login links by email.
  await deps.ensureAccount(email);
  if (prov.new_client) await deps.saveSource(prov.client_id).catch(() => {});

  const sendErr = prov.kind === "intake"
    ? await deps.sendIntake(email, prov.client_id, prov.intake_token)
    : await deps.sendSignIn(email, prov.client_id);
  if (sendErr) {
    await deps.mark(gate.attempt_id, "send_failed");
    return { status: 502, body: { error: "We could not send the email. Try again in a few minutes." } };
  }
  await deps.mark(gate.attempt_id, "sent");
  return OK;
}
