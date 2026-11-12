// Slice 1 — the status view (the implementation specification).
//
// JS twin of the precedence inside public.client_onboarding_facts(). The database is the
// authority; this module exists so the precedence is unit-testable with fixture rows and so
// the UI can turn a next_action into one honest sentence. If you change the order here,
// change the SQL in the same commit — parity is checked live against production.

export const ACTION_ORDER = [
  "send_intake", "intake_expired_resend", "awaiting_client_intake", "review_draft",
  "assemble_nutrition", "release", "send_invite", "invite_expired_resend",
  "awaiting_client_claim", "awaiting_first_open", "awaiting_first_set", "onboarded",
];

// Mirrors the CASE in the SQL. A client with a LIVE program is never sent back to intake.
export function nextAction(f) {
  const live = !!f.program_live;
  if (!live && f.intake_state === "none") return "send_intake";
  if (!live && f.intake_state === "expired") return "intake_expired_resend";
  if (!live && f.intake_state === "pending") return "awaiting_client_intake";
  if (!live && (f.draft_state === "draft" || f.draft_state === "held_medical")) return "review_draft";
  if (!live) return "unclassified";
  // "declined" (D6) is a satisfied item, like "assigned".
  if (f.nutrition_state === "none") return "assemble_nutrition";
  if (f.nutrition_state === "draft") return "release";
  if (f.invite_state === "none") return "send_invite";
  if (f.invite_state === "expired") return "invite_expired_resend";
  if (f.invite_state === "pending") return "awaiting_client_claim";
  if (!f.opened_app) return "awaiting_first_open";
  if (!f.first_set_logged) return "awaiting_first_set";
  return "onboarded";
}

// Whose move it is. "coach" = a click of yours; "client" = waiting on them; "done" = nothing owed.
export function actionOwner(action) {
  switch (action) {
    case "send_intake": case "intake_expired_resend": case "review_draft":
    case "assemble_nutrition": case "release": case "send_invite": case "invite_expired_resend":
      return "coach";
    case "awaiting_client_intake": case "awaiting_client_claim":
    case "awaiting_first_open": case "awaiting_first_set":
      return "client";
    case "onboarded": return "done";
    default: return "unknown";
  }
}

const days = (n) => (n === 1 ? "1 day" : `${n} days`);

// One line under the roster name. Says what is true and how long it has been true.
// Never invents: an unknown state renders as unknown, not as a guess.
export function statusLine(f) {
  if (!f) return "Status not loaded";
  const d = Number.isFinite(f.stalled_days) ? f.stalled_days : null;
  const ago = d == null ? "" : d === 0 ? " today" : ` ${days(d)} ago`;
  switch (f.next_action) {
    case "send_intake": return "No intake sent yet";
    case "intake_expired_resend": return `Intake expired${ago}, never submitted — resend`;
    case "awaiting_client_intake": return `Intake sent${ago}, not submitted`;
    case "review_draft": return f.draft_state === "held_medical" ? `Draft held for medical review${ago}` : `Program draft waiting on you${ago}`;
    case "assemble_nutrition": return `Program live${ago}, no nutrition plan yet`;
    case "release": return `Nutrition drafted${ago}, not released`;
    case "send_invite": return `Released${ago}, app invite not sent`;
    case "invite_expired_resend": return `Invite expired${ago}, never claimed — resend`;
    case "awaiting_client_claim": return `Invited${ago}, has not signed in`;
    case "awaiting_first_open": return `Signed in${ago}, has not opened the app`;
    case "awaiting_first_set": return `In the app${ago}, no set logged yet`;
    case "onboarded": return "Onboarded";
    case "unclassified": return "Position unclear — read the row";
    default: return "Status unknown";
  }
}

// "Stuck" = not onboarded, not paused, and unchanged for 3+ days. Paused clients are
// deliberately excluded: a pause is a decision already made, not a stall.
export const STUCK_AFTER_DAYS = 3;
export function isStuck(f) {
  if (!f || f.client_status === "paused") return false;
  if (f.next_action === "onboarded") return false;
  return (f.stalled_days ?? 0) >= STUCK_AFTER_DAYS;
}

// Index a facts result set by client id. Returns null for a failed read (never an empty Map),
// so the UI can tell "no facts" from "could not read facts".
export function indexFacts(rows) {
  if (!Array.isArray(rows)) return null;
  return new Map(rows.map((r) => [r.client_id, r]));
}
