// checkinAssess.ts — the check-in v2 generator core. Reads one check-in plus this
// client's tagging history and proposes a position in the coach's loop framework.
// Shared between the JWT-auth wrapper
// (checkin-assess/index.ts) and its own tests.
//
// Owner-tenant only: keep framework assessment out of other coaches' tenants
// until they explicitly support this workflow. This gate prevents accidental
// framework language from reaching a white-label client.
//
// THE GATE, applied to every field this writes:
//   - proposed_tag is never authoritative. confirmed_tag is coach-only and this file
//     never sets it, never reads it as an input to overwrite, and never touches a row
//     where confirmed_tag is already set (regeneration must not clobber their judgment).
//   - No evidence, no tag. Declining is a valid, expected, frequently correct output.
//   - Word-matching is never evidence. The model is told this explicitly.
//   - Every clause in the summary must trace to a field. Nothing estimated, rounded,
//     or smoothed. A zero reads as a zero. A blank reads as a blank, never filled.

import { OWNER_TENANT_SLUG } from "./owner.ts";

const ANTHROPIC_MODEL = "claude-sonnet-5";
const MODEL_LABEL = "claude-sonnet-5-checkin-assess-v1";

const STAGES = ["M01", "M02", "M03", "M04", "M05"];

const RECORD_ASSESSMENT_TOOL = {
  name: "record_assessment",
  description: "Record this check-in's summary and coach's loop framework stage proposal.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        description: "Four lines maximum. Flat, factual, no coaching voice. Every clause traces to a field.",
      },
      excluded_fields: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            field_key: { type: "string" },
            reason: { type: "string", enum: ["blank", "not_asked", "undecidable"] },
          },
          required: ["field_key", "reason"],
        },
      },
      proposed_tag: {
        type: ["string", "null"],
        enum: [...STAGES, null],
      },
      proposed_evidence: {
        type: "array",
        minItems: 0,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            field_key: { type: "string" },
            quote_or_value: { type: "string" },
            why: { type: "string" },
          },
          required: ["field_key", "quote_or_value", "why"],
        },
      },
      no_tag_reason: {
        type: ["string", "null"],
        description:
          "Required (non-null) whenever proposed_tag is null. One of insufficient_evidence, requires_history, client_type_unknown, prep_physiology, or a short free-text reason.",
      },
    },
    required: ["summary", "excluded_fields", "proposed_tag", "proposed_evidence", "no_tag_reason"],
  },
};

function daysOut(showDate: string | null) {
  if (!showDate) return null;
  const ms = new Date(showDate + "T00:00:00Z").getTime() - Date.now();
  return Math.round(ms / 86400000);
}

// The system prompt is the entire rulebook. Nothing about tagging discipline is
// left to model default behaviour — every hard rule is stated
// explicitly, because an LLM's helpful instinct is exactly the failure mode this
// design exists to prevent (a plausible-sounding read presented as a finding).
function buildSystemPrompt() {
  return `You are the read-generator for a coach's check-in system. You read one client check-in and propose where they sit in the coach's loop framework (M01 Stimulus -> M02 Interpretation -> M03 Avoidance Signal -> M04 Default Behavior -> M05 Identity Lock). You are a proposal, never an authority — a human coach confirms or rejects everything you write, and nothing you output is shown to the client or acted on automatically.

HARD RULES. Every one of these is non-negotiable, not a style preference.

1. Every clause in your summary must trace to a specific field in the check-in answers. If it cannot cite the answer it came from, do not write it.
2. Never name a value that is not in the answers. No estimating, no rounding, no plausible-looking numbers.
3. Never smooth a number into an adjective. "4.5 hours" not "sleep was a bit low." The number is the diagnosis.
4. Never soften a zero. "Zero of four sessions," not "training was inconsistent." A zero is a real fact about a real man who had something to do and did not do it.
5. Never fill a blank. If a field was left empty, say it was not answered and list it in excluded_fields with reason "blank." Never guess what it probably was.
6. A field the tenant never asks (not in this check-in's configured question set) is a different kind of gap than a blank one. List it in excluded_fields with reason "not_asked" — this is a system gap, never a client failing, and it must never be worded as if the client left it blank.
7. If you cannot tell whether a missing value is "blank" or "not_asked," use reason "undecidable" and say so. That is a finding, not something to guess past.
8. Always name what you excluded. A summary with silent omissions is an invented picture wearing a paragraph.
9. Never infer a cause where two explanations fit the same evidence — name both, and name the one thing that would settle it, rather than picking one.
10. Describe only this one check-in. Never reach back and blend a prior week's answers into the summary itself (history may inform the STAGE proposal, per the rules below, but the summary describes this week only).
11. Word-matching is never evidence. The word "struggled" appearing in the struggled-with field is the client answering the question they were asked, not an avoidance signal on its own. Evidence must be a behavioural fact, a number, or the client's own account of their own reasoning, quoted or stated exactly.
12. No evidence, no tag. Declining to propose a stage is a valid, expected, and frequently correct output — do not strain to find a tag where the evidence is thin.

WHAT EACH STAGE REQUIRES, readable from one check-in vs. needing history:
- M01 Stimulus: readable from one check-in. The client names an event or change — this is what the "what changed this week" field is for.
- M02 Interpretation: readable from one check-in. The client states what they made an event mean, in their own words — usually the negotiation field or the macros detail. Never inferred from tone alone.
- M03 Avoidance Signal: usually NOT readable from one check-in. Most tells are comparative (hedging that wasn't there before, detail collapsing). Only propose M03 from a single check-in when the client explicitly reports pre-negotiating themselves out of something ("didn't" on the sessions qualifier, or a direct statement in the negotiation field). Otherwise this needs history — decline with no_tag_reason "requires_history."
- M04 Default Behavior: requires a PRIOR PATTERN across check-ins to be a default rather than a one-off. Never proposable from a single check-in. If history is thin, decline with "requires_history."
- M05 Identity Lock: only proposable when the client says it outright ("I'm just not someone who...") — quote it verbatim as the evidence. Otherwise requires history.

When history is required and you do not have enough of it, report no_tag_reason "requires_history" — never "insufficient_evidence" (that is for when the CURRENT check-in itself lacks the needed content) and never silently downgrade to a softer tag.

PREP / LIFESTYLE GATING. Before proposing ANY tag that rests on hunger, cravings, energy, or fatigue:
- If client_type is "prep" and the client is within a normal late-prep window of their show date, that pattern is expected physiology, not avoidance. A tag resting only on it is not proposable — decline with no_tag_reason "prep_physiology."
- If client_type is null (not yet classified), you may NOT propose any tag resting on appetite, hunger, energy, or cravings at all, for any reason. Decline with no_tag_reason "client_type_unknown." This is a gap in the coach's records, not a fact about the client — never word it as if the client is at fault.
- If client_type is "lifestyle," normal rules apply.

CORRECTION HISTORY. If the coach has previously corrected a proposal for this specific client, that correction and its stated reason are supplied to you below. Weight it for THIS client only — it tells you how this specific coach reads this specific person, not a general rule.

OUTPUT. Call record_assessment exactly once with your result. Do not write any other text.`;
}

function buildUserPrompt({ checkin, tenantQuestions, client, priorCheckins, corrections }: any) {
  const lines = [];

  lines.push(`CLIENT CONTEXT`);
  lines.push(`client_type: ${client.client_type ?? "null (not classified)"}`);
  if (client.client_type === "prep") {
    const d = daysOut(client.show_date);
    lines.push(`show_date days-out: ${client.show_date ? d : "not set"}`);
  }
  lines.push("");

  lines.push(`THIS TENANT'S CONFIGURED QUESTION SET (anything not listed here was never asked):`);
  lines.push(JSON.stringify(tenantQuestions.map((q: any) => ({ id: q.id, text: q.text })), null, 2));
  lines.push("");

  lines.push(`THIS CHECK-IN'S RAW ANSWERS (submitted ${checkin.submitted_at}):`);
  lines.push(`weight: ${checkin.weight ?? "not answered"}`);
  lines.push(JSON.stringify(checkin.answers ?? {}, null, 2));
  lines.push("");

  if (priorCheckins.length) {
    lines.push(`RECENT HISTORY FOR THIS CLIENT (most recent first, confirmed stage only — a stage that is still "proposed, unconfirmed" is not shown because it does not count as a real position):`);
    for (const p of priorCheckins) {
      lines.push(`- ${p.submitted_at}: confirmed_tag=${p.confirmed_tag ?? "none / not confirmed"}`);
    }
    lines.push("");
  } else {
    lines.push(`RECENT HISTORY FOR THIS CLIENT: none. This may be the first check-in on record for them, or the first since this system started. Treat any comparative or pattern-based stage (M03 comparative, M04, M05 unless stated outright) as requiring history you do not have.`);
    lines.push("");
  }

  if (corrections.length) {
    lines.push(`PRIOR COACH CORRECTIONS FOR THIS CLIENT (most recent first — this is how this coach reads this person):`);
    for (const c of corrections) {
      lines.push(`- proposed ${c.from_tag ?? "(nothing)"}, coach corrected to ${c.to_tag ?? "(no tag)"}${c.reason ? `, reason: "${c.reason}"` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Calls Anthropic and returns the validated tool-call arguments, or throws.
async function callGenerator(promptInput: any) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — generator cannot run");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: buildUserPrompt(promptInput) }],
      tools: [RECORD_ASSESSMENT_TOOL],
      tool_choice: { type: "tool", name: "record_assessment" },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`anthropic api error ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const toolUse = (data.content || []).find((b: any) => b.type === "tool_use" && b.name === "record_assessment");
  if (!toolUse) throw new Error("model did not call record_assessment");
  return toolUse.input;
}

function validateResult(r: any) {
  if (typeof r?.summary !== "string" || !r.summary.trim()) throw new Error("empty summary");
  if (r.proposed_tag !== null && !STAGES.includes(r.proposed_tag)) throw new Error(`bad proposed_tag: ${r.proposed_tag}`);
  if (r.proposed_tag !== null && (!Array.isArray(r.proposed_evidence) || r.proposed_evidence.length < 1)) {
    throw new Error("proposed_tag set with no evidence — no evidence, no tag");
  }
  if (r.proposed_tag === null && !r.no_tag_reason) throw new Error("declined with no no_tag_reason");
  if (!Array.isArray(r.excluded_fields)) throw new Error("excluded_fields must be an array");
}

// The full pipeline for one checkin_id. Idempotent-safe: if the coach already
// confirmed a tag on this checkin, this is a no-op — regeneration must never
// overwrite a settled human judgment.
export async function assessCheckin(db: any, checkinId: string) {
  const { data: checkin, error: ckErr } = await db.from("checkins").select("*").eq("id", checkinId).maybeSingle();
  if (ckErr || !checkin) return { skipped: "checkin not found" };

  const { data: tenant } = await db.from("tenants").select("slug").eq("id", checkin.tenant_id).maybeSingle();
  if (tenant?.slug !== OWNER_TENANT_SLUG) {
    return { skipped: "generator is owner-only — framework assessment is not enabled for other tenants" };
  }

  const { data: existing } = await db
    .from("checkin_assessments")
    .select("id, confirmed_tag")
    .eq("checkin_id", checkinId)
    .maybeSingle();
  if (existing?.confirmed_tag) {
    return { skipped: "already confirmed — never regenerated over a coach's settled judgment" };
  }

  const { data: client } = await db
    .from("clients")
    .select("id, client_type, show_date")
    .eq("id", checkin.client_id)
    .maybeSingle();
  if (!client) return { skipped: "client not found" };

  const { data: tenantConfig } = await db
    .from("tenant_config")
    .select("checkin_fields")
    .eq("tenant_id", checkin.tenant_id)
    .maybeSingle();
  const tenantQuestions = tenantConfig?.checkin_fields?.questions ?? [];

  const { data: priorCheckinsRaw } = await db
    .from("checkins")
    .select("id, submitted_at")
    .eq("client_id", client.id)
    .neq("id", checkinId)
    .order("submitted_at", { ascending: false })
    .limit(8);
  const priorIds = (priorCheckinsRaw ?? []).map((c: any) => c.id);
  let priorTags: Record<string, string | null> = {};
  if (priorIds.length) {
    const { data: priorAssessments } = await db
      .from("checkin_assessments")
      .select("checkin_id, confirmed_tag")
      .in("checkin_id", priorIds);
    priorTags = Object.fromEntries((priorAssessments ?? []).map((a: any) => [a.checkin_id, a.confirmed_tag]));
  }
  const priorCheckins = (priorCheckinsRaw ?? []).map((c: any) => ({
    submitted_at: c.submitted_at,
    confirmed_tag: priorTags[c.id] ?? null,
  }));

  const { data: corrections } = await db
    .from("checkin_tag_corrections")
    .select("from_tag, to_tag, reason, corrected_at")
    .eq("client_id", client.id)
    .order("corrected_at", { ascending: false })
    .limit(5);

  const result = await callGenerator({
    checkin,
    tenantQuestions,
    client,
    priorCheckins,
    corrections: corrections ?? [],
  });
  validateResult(result);

  const row = {
    tenant_id: checkin.tenant_id,
    checkin_id: checkinId,
    client_id: client.id,
    summary: result.summary,
    summary_model: MODEL_LABEL,
    summary_generated_at: new Date().toISOString(),
    excluded_fields: result.excluded_fields,
    proposed_tag: result.proposed_tag,
    proposed_evidence: result.proposed_evidence,
    proposed_at: new Date().toISOString(),
    no_tag_reason: result.no_tag_reason,
  };

  const { error: upsertErr } = await db
    .from("checkin_assessments")
    .upsert(row, { onConflict: "checkin_id" });
  if (upsertErr) throw upsertErr;

  return { ok: true, proposed_tag: result.proposed_tag };
}

export { buildSystemPrompt, buildUserPrompt, validateResult, daysOut, STAGES };
