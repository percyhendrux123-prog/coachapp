// Pure enrollment decision for challenge-enroll — kept free of I/O so it can be tested.
//
// Order: the challenge must be enrollable (published — not draft, not archived) before
// anything else; then the audience gate, which needs the caller's client status only
// when the audience is restricted. The caller handles "already enrolled" (idempotent)
// between those two steps, and the insert race via isUniqueViolation.

export type EnrollChallenge = { id: string; status: string; audience?: string | null };

// ok: true = admit · false = refuse (status + error) · undefined = the caller must look up
// whether the participant is a client and call again with isClient set.
export type EnrollDecision = { ok: boolean | undefined; status?: number; error?: string; needsClientLookup: boolean };

const AUDIENCES = new Set(["open", "clients_only", "non_clients_only"]);

export function enrollDecision(
  { challenge, isClient }: { challenge: EnrollChallenge; isClient: boolean | undefined },
): EnrollDecision {
  if (challenge.status === "archived")
    return { ok: false, status: 409, error: "challenge is archived", needsClientLookup: false };
  if (challenge.status !== "published")
    return { ok: false, status: 409, error: "challenge is not open for enrollment", needsClientLookup: false };

  const audience = challenge.audience ?? "open";
  if (!AUDIENCES.has(audience))
    return { ok: false, status: 409, error: "challenge audience is not recognised", needsClientLookup: false };
  if (audience === "open") return { ok: true, needsClientLookup: false };

  if (isClient === undefined) return { ok: undefined, needsClientLookup: true };
  if (audience === "clients_only" && !isClient)
    return { ok: false, status: 403, error: "this challenge is open to existing clients only", needsClientLookup: true };
  if (audience === "non_clients_only" && isClient)
    return { ok: false, status: 403, error: "Not open to current coaching clients.", needsClientLookup: true };
  return { ok: true, needsClientLookup: false };
}

// ---------------------------------------------------------------------------------
// "Is this person a client?" for the audience gate.
//
// The boundary is the CURRENT coaching
// relationship, not the historical existence of a clients row. Before this, any row at
// all — an archived former client, an intake that never started, a SYSTEM buyer — was
// refused from a non_clients_only challenge. Smallest safe predicate:
//   current relationship = status is active or paused
//                          OR live coaching billing (subscription_status active / trialing / past_due)
// Everything else (archived, invited with no live billing, no row) is NOT a client for
// this purpose. Billing wins over a mislabeled status, so an "invited" row that is
// actually being billed still counts as a client.
export type ClientRelationshipRow = { status?: string | null; subscription_status?: string | null };

const RELATIONSHIP_STATUSES = new Set(["active", "paused"]);
const LIVE_BILLING = new Set(["active", "trialing", "past_due"]);

export function hasCurrentCoachingRelationship(row: ClientRelationshipRow | null | undefined): boolean {
  if (!row) return false;
  if (RELATIONSHIP_STATUSES.has(String(row.status ?? ""))) return true;
  if (LIVE_BILLING.has(String(row.subscription_status ?? ""))) return true;
  return false;
}

// Postgres unique_violation — the unique(challenge_id, participant_user_id) index firing
// under a concurrent double-enroll. The caller resolves it to the existing run.
export function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && error.code === "23505");
}

// The database capacity trigger (trg_challenge_runs_capacity) refuses with hint
// 'challenge_full' / message 'challenge is full'. Surfaced through PostgREST as P0001.
export function isChallengeFull(error: { code?: string; message?: string; hint?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return error.hint === "challenge_full" || /challenge is full/i.test(String(error.message ?? ""));
}
