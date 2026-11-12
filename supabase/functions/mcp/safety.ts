export type ConnectorKind = "coach" | "client";

type AuditRule = "uuid" | "integer" | "boolean" | "count" | "structure";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
};

export const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const UUID_RE = new RegExp(UUID_PATTERN, "i");

const AUDIT_RULES: Record<string, Record<string, AuditRule>> = {
  get_client: { client_id: "uuid" },
  list_checkins: { client_id: "uuid", limit: "integer" },
  get_client_workouts: { client_id: "uuid", limit: "integer" },
  get_client_schedule: { client_id: "uuid", days_ahead: "integer" },
  get_client_progress: { client_id: "uuid" },
  list_progress_photos: { client_id: "uuid", limit: "integer" },
  update_client_prep_info: { client_id: "uuid" },
  update_client_status: { client_id: "uuid" },
  create_challenge: { duration_days: "integer", standards: "count" },
  publish_challenge: { challenge_id: "uuid" },
  enroll_client_in_challenge: { challenge_id: "uuid", client_id: "uuid" },
  generate_program_draft: { client_id: "uuid", days_per_week: "integer" },
  get_program: { program_id: "uuid" },
  list_messages: { client_id: "uuid", limit: "integer" },
  search_clients: { limit: "integer" },
  list_inbox: { limit: "integer" },
  list_client_notes: { client_id: "uuid", limit: "integer", include_archived: "boolean" },
  get_support_queue: { stale_after_days: "integer" },
  get_client_support_brief: { client_id: "uuid" },
  get_client_onboarding: { client_id: "uuid", limit: "integer" },
  get_client_parq: { client_id: "uuid" },
  update_client_onboarding: { client_id: "uuid", sync_profile: "boolean" },
  update_client_profile_metrics: { client_id: "uuid" },
  get_client_activity_log: { client_id: "uuid", limit: "integer", kinds: "count" },
  get_engagement_report: { window_days: "integer", slipping_after_days: "integer", dormant_after_days: "integer" },
  get_checkin_detail: { checkin_id: "uuid" },
  compare_progress_photos: { client_id: "uuid" },
  reply_to_checkin: { checkin_id: "uuid", mark_seen: "boolean" },
  get_client_program_history: { client_id: "uuid", limit: "integer" },
  create_client_note: { client_id: "uuid" },
  update_client_note: { note_id: "uuid" },
  log_workout_on_behalf: { client_id: "uuid", sets: "count" },
  get_nutrition_history: { client_id: "uuid", limit: "integer" },
  edit_meal_plan: { plan_id: "uuid", slot_edits: "count" },
  create_custom_meal: { base_servings: "integer", publish: "boolean" },
  list_community_posts: { limit: "integer", pin_first: "boolean" },
  get_community_post: { post_id: "uuid" },
  get_community_engagement: { window_days: "integer" },
  post_to_community: { pinned: "boolean" },
  moderate_community_post: { post_id: "uuid", confirm_delete: "boolean" },
  send_bulk_message: { client_ids: "count", confirm_recipient_count: "integer" },
  get_compliance_status: { client_id: "uuid" },
  get_roster_state: { client_ids: "count", window_days: "integer", include: "count" },
  list_programs: { include_archived: "boolean" },
  get_escalation_history: { client_id: "uuid", limit: "integer" },
  get_message_templates: { limit: "integer" },
  archive_client_note: { note_id: "uuid", archived: "boolean" },
  archive_program: { program_id: "uuid", archived: "boolean" },
  delete_program: { program_id: "uuid" },
  create_support_ticket: { ticket_id: "uuid", client_id: "uuid" },
  save_message_template: {},
  list_client_documents: { client_id: "uuid", limit: "integer" },
  get_client_document: { document_id: "uuid" },
  upload_client_document: { client_id: "uuid" },
  send_message: { client_id: "uuid" },
  mark_thread_read: { client_id: "uuid" },
  mark_checkin_seen: { checkin_id: "uuid" },
  list_brief_slides: {},
  add_brief_slide: { position: "integer" },
  update_brief_slide: { slide_id: "uuid", position: "integer" },
  remove_brief_slide: { slide_id: "uuid" },
  create_program: { structure: "structure" },
  update_program: { program_id: "uuid", structure: "structure", allow_removals: "boolean" },
  duplicate_program: { program_id: "uuid" },
  assign_program: { program_id: "uuid", client_ids: "count" },
  get_meal_plan: { client_id: "uuid" },
  list_meals: { limit: "integer" },
  assemble_meal_plan: { client_id: "uuid", meals_per_day: "integer", rotation_days: "integer" },
  release_meal_plan: { plan_id: "uuid" },
  my_workouts: { limit: "integer" },
  my_checkins: { limit: "integer" },
  my_messages: { limit: "integer" },
  my_schedule: { days_ahead: "integer" },
  log_workout_sets: { day_id: "uuid", sets: "count" },
  complete_current_day: { day_id: "uuid" },
  set_my_meals: { assignments: "count" },
};

/** Tool names that have an audit rule. Used by toolSurface.test.ts to catch blank audit rows. */
export const AUDIT_RULES_TOOLS = Object.keys(AUDIT_RULES);

function structureSummary(value: unknown) {
  const structure = value as { days?: Array<{ groups?: Array<{ exercises?: unknown[] }> }> } | null;
  const days = Array.isArray(structure?.days) ? structure.days : [];
  return {
    days: days.length,
    exercises: days.flatMap((day) => Array.isArray(day?.groups) ? day.groups : [])
      .flatMap((group) => Array.isArray(group?.exercises) ? group.exercises : []).length,
  };
}

// Failure reasons recorded here are SERVER-GENERATED strings only — ToolError messages this
// codebase writes, or the validator's own complaint. Never caller free text, never a row value.
//
// WHY THIS EXISTS: get_support_queue failed on every call for a week and the failure was
// undiagnosable, because every one of those failures was logged as bare `{ok:false}`. A log that
// records that something broke but never what broke retires the suspicion that makes anyone look.
export const AUDIT_ERROR_MAX = 300;

export function summarizeAuditArguments(
  tool: string,
  args: unknown,
  ok: boolean,
  errorMessage?: unknown,
): Record<string, unknown> {
  const summary: Record<string, unknown> = { ok };
  if (!ok && typeof errorMessage === "string" && errorMessage.trim()) {
    summary.error = errorMessage.trim().slice(0, AUDIT_ERROR_MAX);
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return summary;

  const rules = AUDIT_RULES[tool] ?? {};
  const input = args as Record<string, unknown>;
  for (const [field, rule] of Object.entries(rules)) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (rule === "uuid" && typeof value === "string" && UUID_RE.test(value)) summary[field] = value;
    else if (rule === "integer" && Number.isInteger(value)) summary[field] = value;
    else if (rule === "boolean" && typeof value === "boolean") summary[field] = value;
    else if (rule === "count" && Array.isArray(value)) summary[`${field}_count`] = value.length;
    else if (rule === "structure") summary[field] = structureSummary(value);
  }
  return summary;
}

export function validateToolArguments(schema: JsonSchema, value: unknown, path = "arguments"): string | null {
  if (Array.isArray(schema.type)) {
    const matches = schema.type.some((type) => validateToolArguments({ ...schema, type }, value, path) === null);
    return matches ? null : `${path} must match one of: ${schema.type.join(", ")}`;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object`;
    const object = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const field of schema.required ?? []) {
      if (!(field in object)) return `${path}.${field} is required`;
    }
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(object).find((field) => !(field in properties));
      if (unexpected) return `${path}.${unexpected} is not allowed`;
    }
    for (const [field, child] of Object.entries(properties)) {
      if (!(field in object)) continue;
      const error = validateToolArguments(child, object[field], `${path}.${field}`);
      if (error) return error;
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.minItems != null && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} item(s)`;
    if (schema.maxItems != null && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} item(s)`;
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateToolArguments(schema.items, value[index], `${path}[${index}]`);
        if (error) return error;
      }
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string`;
    if (schema.minLength != null && value.length < schema.minLength) return `${path} is too short`;
    if (schema.maxLength != null && value.length > schema.maxLength) return `${path} is too long`;
    if (schema.pattern && !new RegExp(schema.pattern, "i").test(value)) return `${path} has an invalid format`;
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) return `${path} must be an integer`;
    if (schema.minimum != null && (value as number) < schema.minimum) return `${path} is below the minimum`;
    if (schema.maximum != null && (value as number) > schema.maximum) return `${path} is above the maximum`;
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a finite number`;
    if (schema.minimum != null && value < schema.minimum) return `${path} is below the minimum`;
    if (schema.maximum != null && value > schema.maximum) return `${path} is above the maximum`;
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    return `${path} must be a boolean`;
  } else if (schema.type === "null" && value !== null) {
    return `${path} must be null`;
  } else if (schema.type === undefined) {
    return `${path} schema is missing a type`;
  } else if (!["object", "array", "string", "integer", "number", "boolean", "null"].includes(schema.type)) {
    return `${path} schema type is unsupported`;
  }

  if (schema.enum && !schema.enum.some((option) => Object.is(option, value))) return `${path} is not an allowed value`;
  return null;
}

export type ToolScope = "comms" | "owner";
// Client tokens: 'comms' unlocks comms/logging writes; 'owner' unlocks those AND the owner
// tools (self-serve only — the DB trigger is what makes an owner token exist at all).
// Coach tokens never see client tools; toolScope 'owner' on a coach token is refused outright.
export function canUseTool(kind: ConnectorKind, scope: string, writes: boolean, toolScope?: ToolScope): boolean {
  if (!writes) return true;
  if (kind === "coach") return toolScope !== "owner" && scope === "read_write";
  if (scope === "owner") return true;
  if (scope === "comms") return toolScope !== "owner";
  return false;
}

// A self-serve tenant has no coach. Tools that relay TO a coach —
// message_coach, flag_issue — would write into an inbox nobody opens and report `sent`.
// Found live 2026-09-03: an owner token (owner ⊇ comms) passed canUseTool and did exactly
// that. Such tools are hidden from tools/list and refused on tools/call there. Pure so it
// can be tested; the tenant mode is read once at authentication.
export const hiddenWithoutCoach = (selfServe: boolean, needsCoach?: boolean): boolean =>
  Boolean(selfServe && needsCoach);

export const NO_COACH_TEXT =
  "This plan has no coach. The Self-serve plan has no coach inbox — nobody reads coach messages here, so nothing was sent. Your record, check-ins and program are yours to work from.";

// PostgREST .or() filter: global library, tenant library (not another buyer's custom meal),
// and — when a client is in context — that client's own custom meals.
export function mealLibraryVisibilityFilter(tenantId: string, clientId?: string | null): string {
  if (!UUID_RE.test(tenantId)) throw new Error("invalid tenant id");
  const base = `tenant_id.is.null,and(tenant_id.eq.${tenantId},owner_client_id.is.null)`;
  if (!clientId) return base;
  if (!UUID_RE.test(clientId)) throw new Error("invalid client id");
  return `${base},owner_client_id.eq.${clientId}`;
}
