import { supabase } from "./supabase";
import { listClients } from "./coachClients";
import { availableDraftStyles } from "./whiteLabelPolicy";

// the owner's own read of a proposed Default Paralysis Loop stage — the two verbs
// the implementation specification Part 5 describes as different acts: confirming agrees
// with the machine, correcting disagrees. Both always land here, never a plain
// update — the underlying function is what writes the correction-log row when
// the confirmed tag differs from what was proposed.
export async function confirmCheckinTag(assessmentId, tag, reason = null) {
  const { data, error } = await supabase.rpc("confirm_checkin_tag", {
    p_assessment_id: assessmentId,
    p_tag: tag,
    p_reason: reason,
  });
  if (error) throw error;
  return data;
}

// "No tag is right." Not the same as ignoring the proposal — this clears
// needs_review (the owner looked) while confirmed_tag stays null (nothing counts
// as a position), and it always writes a correction row.
export async function rejectCheckinTag(assessmentId, reason = null) {
  const { data, error } = await supabase.rpc("reject_checkin_tag", {
    p_assessment_id: assessmentId,
    p_reason: reason,
  });
  if (error) throw error;
  return data;
}

const ACTIVE_STATUSES = new Set(["active", "invited", "paused"]);

export async function fetchCoachCockpit(tenant) {
  const [clients, checkins, messages, workouts, assessments] = await Promise.all([
    listClients(),
    listRecentCheckins(),
    listRecentMessages(),
    listRecentWorkouts(),
    listRecentAssessments(),
  ]);

  const now = Date.now();
  const checkinsByClient = groupBy(checkins, "client_id");
  const messagesByClient = groupBy(messages, "client_id");
  const workoutsByClient = groupBy(workouts, "client_id");
  const assessmentsByCheckin = new Map(assessments.map((a) => [a.checkin_id, a]));

  const rows = clients
    .filter((client) => ACTIVE_STATUSES.has(client.status || "active"))
    .map((client) => {
      const clientCheckins = checkinsByClient.get(client.id) ?? [];
      const clientMessages = messagesByClient.get(client.id) ?? [];
      const clientWorkouts = workoutsByClient.get(client.id) ?? [];
      const latestCheckin = clientCheckins[0] ?? null;
      const latestMessage = clientMessages[0] ?? null;
      const latestWorkout = clientWorkouts[0] ?? null;
      const latestAssessment = latestCheckin ? assessmentsByCheckin.get(latestCheckin.id) ?? null : null;

      return buildPriorityRow({
        client,
        latestCheckin,
        latestMessage,
        latestWorkout,
        latestAssessment,
        now,
        draftStyles: availableDraftStyles(tenant),
      });
    })
    .sort((a, b) => b.score - a.score || staleMs(b.lastSignalAt) - staleMs(a.lastSignalAt));

  return {
    generatedAt: new Date().toISOString(),
    clients: rows,
    stats: {
      total: rows.length,
      urgent: rows.filter((r) => r.band === "act").length,
      drafts: rows.filter((r) => r.draft).length,
      unseenCheckins: rows.filter((r) => r.latestCheckin && !r.latestCheckin.coach_seen).length,
    },
  };
}

async function listRecentCheckins() {
  const { data, error } = await supabase
    .from("checkins")
    .select("id, client_id, submitted_at, weight, answers, coach_seen")
    .order("submitted_at", { ascending: false })
    .limit(150);
  if (error) throw error;
  return data ?? [];
}

async function listRecentMessages() {
  const { data, error } = await supabase
    .from("messages")
    .select("id, client_id, sender_role, body, sent_at")
    .order("sent_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

async function listRecentWorkouts() {
  const { data, error } = await supabase
    .from("workout_sessions")
    .select("id, client_id, session_date, status, completed_at")
    .order("session_date", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

async function listRecentAssessments() {
  const { data, error } = await supabase
    .from("checkin_assessments")
    .select("id, checkin_id, client_id, summary, proposed_tag, confirmed_tag, needs_review, no_tag_reason, proposed_evidence, created_at")
    .order("created_at", { ascending: false })
    .limit(150);
  if (error) throw error;
  return data ?? [];
}

function buildPriorityRow({ client, latestCheckin, latestMessage, latestWorkout, latestAssessment, now, draftStyles }) {
  const reasons = [];
  let score = 0;

  const checkinAge = ageDays(latestCheckin?.submitted_at, now);
  const workoutAge = ageDays(latestWorkout?.completed_at || latestWorkout?.session_date, now);
  const lastSignalAt = newest([
    latestCheckin?.submitted_at,
    latestMessage?.sent_at,
    latestWorkout?.completed_at || latestWorkout?.session_date,
  ]);

  if (latestCheckin && !latestCheckin.coach_seen) {
    score += 60;
    reasons.push("New check-in needs review.");
  }
  if (latestAssessment?.needs_review) {
    score += 35;
    reasons.push("Assistant assessment is still unconfirmed.");
  }
  if (latestMessage?.sender_role === "client") {
    score += 35;
    reasons.push("Client sent the latest message.");
  }
  if (checkinAge == null || checkinAge >= 8) {
    score += 25;
    reasons.push(checkinAge == null ? "No recent check-in found." : `No check-in for ${checkinAge} days.`);
  }
  if (workoutAge == null || workoutAge >= 7) {
    score += 20;
    reasons.push(workoutAge == null ? "No workout signal found." : `No workout logged for ${workoutAge} days.`);
  }
  if (client.status === "paused") {
    score += 10;
    reasons.push("Client is paused, so next step should be intentional.");
  }

  const summary = makeSummary({ client, latestCheckin, latestMessage, latestWorkout, latestAssessment });
  const draftContext = { client, latestCheckin, latestMessage, latestWorkout, latestAssessment, reasons };
  const drafts = Object.fromEntries(draftStyles.map((style) => [style.key, makeDraft(draftContext, style.key)]));

  return {
    client,
    latestCheckin,
    latestMessage,
    latestWorkout,
    latestAssessment,
    lastSignalAt,
    score,
    band: score >= 75 ? "act" : score >= 35 ? "review" : "steady",
    reasons: reasons.length ? reasons : ["No urgent signal. Keep on normal rhythm."],
    summary,
    draft: drafts.balanced,
    drafts,
  };
}

function makeSummary({ client, latestCheckin, latestMessage, latestWorkout, latestAssessment }) {
  const parts = [];
  if (latestAssessment?.summary) parts.push(latestAssessment.summary);
  else if (latestCheckin) parts.push(`Latest check-in submitted ${dateLabel(latestCheckin.submitted_at)}.`);
  else parts.push("No check-in is visible in the recent window.");

  if (latestWorkout) {
    const label = latestWorkout.completed_at ? "completed" : "scheduled";
    parts.push(`Last workout ${label} ${dateLabel(latestWorkout.completed_at || latestWorkout.session_date)}.`);
  } else {
    parts.push("No recent workout signal is visible.");
  }

  if (latestMessage) {
    const who = latestMessage.sender_role === "coach" ? "you" : "client";
    parts.push(`Latest message was from ${who}: "${truncate(latestMessage.body, 90)}"`);
  }

  if (client.client_type === "prep" && client.show_date) {
    parts.push(`Prep client, show date ${client.show_date}.`);
  }
  return parts.join(" ");
}

function makeDraft(context, style = "balanced") {
  if (style === "supportive") return makeSupportiveDraft(context);
  if (style === "direct") return makeDirectDraft(context);
  if (style === "signature") return makeSignatureDraft(context);
  return makeBalancedDraft(context);
}

function makeBalancedDraft({ client, latestCheckin, latestMessage, latestWorkout, latestAssessment, reasons }) {
  const first = firstName(client.display_name);
  if (!reasons.length || reasons[0].startsWith("No urgent")) {
    return `Hey ${first}, quick check-in. Keep executing today and send me anything you want me to look over before your next update.`;
  }

  const lines = [`Hey ${first}, I reviewed your latest update.`];
  if (latestAssessment?.summary) lines.push(`What I am seeing: ${latestAssessment.summary}`);
  else if (latestCheckin) lines.push("I saw your check-in come through and I want to tighten up the next step with you.");

  if (latestMessage?.sender_role === "client") {
    lines.push(`I also saw your message: "${truncate(latestMessage.body, 120)}"`);
  }
  if (!latestWorkout) lines.push("I do not see a recent workout logged, so tell me what happened there.");
  else if (latestWorkout.status && latestWorkout.status !== "completed") {
    lines.push("I want to know how the last scheduled session actually went.");
  }
  lines.push("Send me a quick reply with what felt hardest this week and what you can commit to today.");
  return lines.join("\n\n");
}

function makeSupportiveDraft({ client, latestCheckin, latestMessage, latestWorkout, latestAssessment, reasons }) {
  const first = firstName(client.display_name);
  if (!reasons.length || reasons[0].startsWith("No urgent")) {
    return `Hey ${first}, you are in a steady spot right now. Keep the basics moving today and send me anything you want a second set of eyes on.`;
  }

  const lines = [`Hey ${first}, thanks for the update. I looked through it and I want to help you make the next step simple.`];
  if (latestAssessment?.summary) lines.push(`Here is what stands out to me: ${latestAssessment.summary}`);
  else if (latestCheckin) lines.push("I saw your check-in, and I want to make sure we respond to the right thing instead of guessing.");
  if (latestMessage?.sender_role === "client") {
    lines.push(`I saw your message too: "${truncate(latestMessage.body, 120)}"`);
  }
  if (!latestWorkout) lines.push("If training got away from you, that is information. Tell me what got in the way and we will adjust.");
  lines.push("Reply with the main thing you need help with today, and I will keep the next move clear.");
  return lines.join("\n\n");
}

function makeDirectDraft({ client, latestMessage, latestWorkout, latestAssessment, reasons }) {
  const first = firstName(client.display_name);
  if (!reasons.length || reasons[0].startsWith("No urgent")) {
    return `Hey ${first}, stay on plan today. If anything changed, send it over before your next check-in.`;
  }

  const lines = [`Hey ${first}, I reviewed the update. Here is what needs attention.`];
  if (latestAssessment?.summary) lines.push(latestAssessment.summary);
  else lines.push(reasons.slice(0, 2).join(" "));
  if (latestMessage?.sender_role === "client") lines.push(`I saw your message: "${truncate(latestMessage.body, 110)}"`);
  if (!latestWorkout) lines.push("I do not see training logged recently. I need to know why.");
  lines.push("Reply with what happened, what you are doing today, and where you need me to adjust.");
  return lines.join("\n\n");
}

function makeSignatureDraft({ client, latestCheckin, latestMessage, latestWorkout, latestAssessment, reasons }) {
  const first = firstName(client.display_name);
  if (!reasons.length || reasons[0].startsWith("No urgent")) {
    return `Hey ${first}, you are not in crisis mode. Keep today clean, hit the basics, and send me anything that actually needs a coach's eyes.`;
  }

  const lines = [`Hey ${first}, I looked at your update. We are going to deal with the real thing, not make a story out of it.`];
  if (latestAssessment?.summary) lines.push(`What I am seeing: ${latestAssessment.summary}`);
  else if (latestCheckin) lines.push("The check-in is in. Now I need the part that tells us what to do next.");
  if (latestMessage?.sender_role === "client") {
    lines.push(`I saw this from you: "${truncate(latestMessage.body, 120)}"`);
  }
  if (!latestWorkout) lines.push("I do not see the training signal. If you missed it, say that plainly and tell me what got in the way.");
  else if (latestWorkout.status && latestWorkout.status !== "completed") {
    lines.push("The session does not read as completed, so I need the honest version of how it went.");
  }
  lines.push("Send me the hard part, the honest reason, and the next action you can execute today.");
  return lines.join("\n\n");
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(row);
  }
  return map;
}

function ageDays(iso, now) {
  if (!iso) return null;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86400000));
}

function newest(values) {
  return values.filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] ?? null;
}

function staleMs(iso) {
  return iso ? new Date(iso).getTime() : 0;
}

function dateLabel(iso) {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function firstName(name) {
  return (name || "there").trim().split(/\s+/)[0] || "there";
}

function truncate(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}...`;
}
