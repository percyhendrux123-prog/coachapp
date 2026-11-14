// Run: deno test --no-check --allow-read supabase/functions/_shared/healthHold.parity.test.ts
// P33: the flag table, the statement and the "none" rule exist three times (this TS, the
// browser's src/lib/healthHold.js + src/lib/mealMacros.js, and SQL). This pins TS to JS; the
// SQL suite (health_screen_attestation.test.sql) pins SQL to the same literal lists.
// @ts-nocheck
import * as ts from "./parq.ts";
import * as js from "../../../src/lib/healthHold.js";
import { normalizeMedications as jsNormalize } from "../../../src/lib/mealMacros.js";
import { computeHealthFlags as tsFlags } from "../intake-submit/mealMacros.ts";
import { computeHealthFlags as jsFlags } from "../../../src/lib/mealMacros.js";

const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

// The literal lists the SQL functions return — kept here so a drift in any twin fails.
export const SQL_DOCTOR_FIRST = ["parq_heart_condition", "parq_chest_pain", "parq_dizziness",
  "parq_bone_joint_worsened_by_activity", "parq_bp_or_heart_medication",
  "parq_other_reason_not_to_exercise", "medication_disclosed"];
export const SQL_BLOCKING = ["pregnancy", "eating_disorder_history"];

Deno.test("flag lists match across TS, JS and the SQL literal", () => {
  eq([...ts.DOCTOR_FIRST_FLAGS], js.DOCTOR_FIRST_FLAGS, "doctor-first TS vs JS");
  eq([...ts.BLOCKING_FLAGS], js.BLOCKING_FLAGS, "blocking TS vs JS");
  eq([...ts.DOCTOR_FIRST_FLAGS], SQL_DOCTOR_FIRST, "doctor-first vs SQL");
  eq([...ts.BLOCKING_FLAGS], SQL_BLOCKING, "blocking vs SQL");
});
Deno.test("statement version and lines match", () => {
  eq(ts.HEALTH_STATEMENT_VERSION, js.HEALTH_STATEMENT_VERSION, "version");
  eq([...ts.HEALTH_STATEMENT_LINES], js.HEALTH_STATEMENT_LINES, "lines");
});
Deno.test("classifyFlags agrees on every case", () => {
  for (const c of [[], ["pregnancy"], ["parq_chest_pain", "x_unknown"], [...SQL_DOCTOR_FIRST, ...SQL_BLOCKING]]) {
    eq(ts.classifyFlags(c), js.classifyFlags(c), JSON.stringify(c));
  }
});
Deno.test("every flag the generator can store is known to the table", () => {
  const all = { parq_heart_condition: true, parq_chest_pain: true, parq_dizziness: true, parq_bone_joint: true,
    parq_bp_meds: true, parq_other_reason: true, pregnant: true, eating_disorder_history: true, medications: "x" };
  const stored = tsFlags(all);
  eq(stored, jsFlags(all), "TS and JS generators store the same ids");
  for (const f of stored) if (![...SQL_DOCTOR_FIRST, ...SQL_BLOCKING].includes(f)) throw new Error("unknown stored id " + f);
});
Deno.test("normalizeMedications agrees and both generators skip a plain none", () => {
  for (const t of ["none", " N/A ", "No.", "none, just lisinopril", "0.5mg x", "-", "--", ""]) eq(ts.normalizeMedications(t), jsNormalize(t), t);
  eq(tsFlags({ medications: "none" }), [], "TS none");
  eq(jsFlags({ medications: "none" }), [], "JS none");
  eq(tsFlags({ medications: "lisinopril" }), ["medication_disclosed"], "TS listed");
});
Deno.test("every flag shows as words, never an id", () => {
  for (const f of [...SQL_DOCTOR_FIRST, ...SQL_BLOCKING]) {
    const [item] = js.flagItems([f]);
    if (!item || /_/.test(item)) throw new Error(`flag ${f} rendered as ${item}`);
  }
});
