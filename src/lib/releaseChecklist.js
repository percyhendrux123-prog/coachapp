// Slice 3 — pure helpers for the Release button. No database import, so these run under
// plain node tests. The database owns the rules; these only put its answers into words.

// The three checklist lines, in order, as { ok, label }. A missing checklist (failed read)
// yields lines that say so — never three green ticks by default.
export function checklistLines(chk, { noNutrition = false } = {}) {
  if (!chk) return [{ ok: null, label: "Checklist could not be read" }];
  const nutritionOk = !!chk.nutrition?.ok || (noNutrition && chk.nutrition?.state === "none");
  return [
    { ok: !!chk.program?.ok, label: chk.program?.detail ?? "Program: unknown" },
    { ok: nutritionOk, label: noNutrition && !chk.nutrition?.ok ? "No nutrition plan for this client (your choice)" : (chk.nutrition?.detail ?? "Nutrition: unknown") },
    { ok: !!chk.email?.ok, label: chk.email?.detail ?? "Email: unknown" },
    // Health is fail-closed at the database: absent here means the checklist predates the
    // gate or could not be read — render it as not ok, never as clear.
    { ok: chk.health?.ok === true, label: chk.health?.detail ?? "Health screen: not readable" },
  ];
}

// Ready = every line ok. The "no nutrition" tick only helps when nothing else satisfies it.
export function isReadyToRelease(chk, { noNutrition = false } = {}) {
  return checklistLines(chk, { noNutrition }).every((l) => l.ok === true);
}

// Whether to offer the D6 tick at all: only when nutrition is the thing missing.
export function offerNoNutrition(chk) {
  return !!chk && !chk.nutrition?.ok && chk.nutrition?.state === "none";
}

// P26: a flagged health screen the coach can review in place. Returns { intakeId, flags } only
// when the database says the screen is flagged and unreviewed and names the intake; anything
// else (clear, reviewed, no screen, unreadable, an older checklist without intake_id) offers
// nothing. The database still decides: review_health_screen() refuses a stale or unflagged
// screen, and release_checklist() honours a review only for the same intake and flags.
export function healthReviewTarget(chk) {
  const h = chk?.health;
  if (!h || h.ok === true || h.state !== "flagged" || !h.intake_id) return null;
  const flags = Array.isArray(h.flags) ? h.flags.map(String) : [];
  if (flags.length === 0) return null;
  return { intakeId: h.intake_id, flags };
}

// Same rule as review_health_screen(): 3 to 1000 characters after trimming. Returns the
// problem in words, or null when the note will be accepted.
export function healthReviewNoteProblem(note) {
  const n = String(note ?? "").trim().length;
  if (n < 3) return "Say what you checked first.";
  if (n > 1000) return "Keep the note under 1000 characters.";
  return null;
}

// "parq_chest_pain" -> "chest pain" for the review box. Display only.
export function healthFlagLabel(flag) {
  return String(flag ?? "").replace(/^parq_/, "").replace(/_/g, " ").trim() || "unnamed flag";
}

// One sentence for what the release did.
export function releaseOutcomeLine(r) {
  if (!r || r.status !== "released") return "Not released.";
  const p = r.program?.action === "published" ? "program published" : "program already live";
  const n = { assigned: "nutrition assigned", declined: "no nutrition, recorded", already_assigned: "nutrition already assigned", already_declined: "nutrition already declined" }[r.nutrition?.action] ?? "nutrition unchanged";
  const i = r.invite?.already_claimed ? "client already has the app" : "invite ready";
  return `Released: ${p}, ${n}, ${i}.`;
}

// A refusal message from the RPC, with the prefix stripped for display.
export function refusalText(err) {
  const m = String(err?.message ?? err ?? "");
  return m.startsWith("release refused: ") ? m.slice("release refused: ".length) : m;
}

// The whole Release action, in order, with every dependency injected so the sequence is
// unit-testable without a browser or a database:
//   1. prepareAccount(clientId)  — client-invite {account_only}; inert + idempotent; a failure
//      here means NOTHING was released (the RPC never ran).
//   2. release(clientId, {noNutrition}) — release_client(); atomic; a refusal or failure
//      here means nothing was released either (the account, if created, is inert).
//   3. openInvite({to, link}) — the coach's mail client with the claim link the RPC minted.
//      A failure here is the only post-commit step, and it is recoverable in place: the
//      release stands, the link is in the result, and the panel shows it with a copy action.
// Returns { ok, stage, message, result?, claimLink? } — stage names where it stopped.
export async function runRelease(deps, { clientId, email, displayName, alreadyClaimed = false, noNutrition = false, buildLink }) {
  const { prepareAccount, release, openInvite } = deps;
  let account = "not_needed";
  if (!alreadyClaimed) {
    if (!email) return { ok: false, stage: "account", message: "Email missing — nothing was changed." };
    try { account = await prepareAccount(clientId); }
    catch (e) { return { ok: false, stage: "account", message: `Could not prepare the sign-in account: ${e?.message ?? e}. Nothing was changed.` }; }
  }
  let result;
  try { result = await release(clientId, { noNutrition }); }
  catch (e) {
    const refused = String(e?.message ?? "").startsWith("release refused:");
    return { ok: false, stage: refused ? "refused" : "release", account,
      message: refused ? `Not released — ${refusalText(e)}. Nothing was changed.` : `Release failed: ${e?.message ?? e}. Nothing was changed.` };
  }
  const claimPath = result?.invite?.claim_path ?? null;
  const claimLink = claimPath && buildLink ? buildLink(claimPath) : claimPath;
  let mail = "";
  if (!result?.invite?.already_claimed && email && claimLink) {
    try { await openInvite({ to: email, displayName, link: claimLink }); mail = " Your mail app is opening with the invite — press send."; }
    catch { mail = " Your mail app did not open — copy the invite link below and send it yourself."; }
  }
  return { ok: true, stage: "done", account, result, claimLink, message: releaseOutcomeLine(result) + mail };
}
