// A self-serve plan user who submitted the intake must end up with a published
// program, an assigned meal plan and a sign-in account. Missing deliverables must not
// go unnoticed; send-digest puts this check at the top of the coach's daily email.
//
// Input rows are list_system_buyers() rows. Every field is a real yes/no fact from the
// database; nothing here is estimated. Rules:
//   - only buyers whose intake was submitted at least STUCK_AFTER_HOURS ago
//   - skipped once moved to coaching (converted_client_id set) or archived (the reader
//     already drops archived rows)
//   - stuck when ANY of program / meal plan / sign-in account is missing
//   - never stuck while health_hold is needs_clearance or blocked (P33): that person is
//     waiting on their own doctor or is not eligible. Nobody here acts on it, so it is
//     counted on its own digest line (healthHoldLine) and never listed as a stuck delivery.
// Mirror: src/lib/systemStuck.js stuckReasons() — keep the two in step (parity test).

export const STUCK_AFTER_HOURS = 24;

export type SystemBuyerRow = {
  client_id: string;
  display_name: string | null;
  email_masked: string | null;
  intake_status: string | null;
  intake_submitted_at: string | null;
  program_published: boolean | null;
  meal_plan_assigned: boolean | null;
  has_account: boolean | null;
  converted_client_id: string | null;
  health_hold?: string | null;
};

export type StuckBuyer = {
  client_id: string;
  name: string;
  hours_since_intake: number;
  missing: string[];
};

export function stuckReasons(r: SystemBuyerRow, now: Date = new Date()): string[] {
  if (r.converted_client_id) return [];
  if (r.health_hold && r.health_hold !== "none") return [];
  if (r.intake_status !== "submitted" || !r.intake_submitted_at) return [];
  const at = Date.parse(r.intake_submitted_at);
  if (!Number.isFinite(at)) return [];
  if (now.getTime() - at < STUCK_AFTER_HOURS * 3600 * 1000) return [];
  const missing: string[] = [];
  if (!r.program_published) missing.push("program");
  if (!r.meal_plan_assigned) missing.push("meal plan");
  if (!r.has_account) missing.push("sign-in account");
  return missing;
}

export function stuckSystemBuyers(rows: SystemBuyerRow[], now: Date = new Date()): StuckBuyer[] {
  return rows
    .map((r) => ({ r, missing: stuckReasons(r, now) }))
    .filter((x) => x.missing.length > 0)
    .map(({ r, missing }) => ({
      client_id: r.client_id,
      name: r.display_name || r.email_masked || "Unnamed user",
      hours_since_intake: Math.floor((now.getTime() - Date.parse(r.intake_submitted_at!)) / 3600000),
      missing,
    }))
    .sort((a, b) => b.hours_since_intake - a.hours_since_intake);
}

// One plain line per buyer for the digest, e.g.
// "Sam Rivera — intake submitted 14 days ago; missing program, meal plan, sign-in account"
export function stuckLine(s: StuckBuyer): string {
  const d = Math.floor(s.hours_since_intake / 24);
  const age = d >= 1 ? `${d} day${d === 1 ? "" : "s"} ago` : `${s.hours_since_intake} hours ago`;
  return `${s.name} — intake submitted ${age}; missing ${s.missing.join(", ")}`;
}

// W11 — one counts-only line for the owner digest. Null when nobody is held.
export function healthHoldCounts(rows: SystemBuyerRow[]): { waiting: number; not_eligible: number } {
  let waiting = 0, not_eligible = 0;
  for (const r of rows) {
    if (r.converted_client_id) continue;
    if (r.health_hold === "needs_clearance") waiting++;
    else if (r.health_hold === "blocked") not_eligible++;
  }
  return { waiting, not_eligible };
}
export function healthHoldLine(rows: SystemBuyerRow[], brand = "Self-serve plan"): string | null {
  const c = healthHoldCounts(rows);
  if (c.waiting === 0 && c.not_eligible === 0) return null;
  return `${brand}: ${c.waiting} waiting on their own doctor, ${c.not_eligible} not eligible. No action for you.`;
}
