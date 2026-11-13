#!/usr/bin/env node
// Builds the two paste-in SQL files in starter-content/ from the JSON next to them:
//   starter-content/sample_programs.sql   adds the sample programs to your coach account
//   starter-content/sample_meal_plan.sql  adds the sample meal plan as a DRAFT for one client
// They are generated, never edited by hand. Edit the JSON, then run
// `node scripts/build-starter-sql.mjs` (the test suite fails if you forget).
//
// The app has no in-app import for programs or meal plans (the only importer is the
// per-client Trainerize import), so these files use the same path SETUP.md already uses:
// paste into the Supabase SQL Editor and click Run.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "starter-content");

// Stable ids so the generated file does not change on every run. Every program gets its own
// ids (they are derived from the program name and position), which is all the app needs:
// workout history hangs off exercise_id + set_index within one program.
function stableUuid(key) {
  const h = createHash("sha256").update(`coachapp-starter:${key}`).digest("hex");
  const v = h.slice(0, 32).split("");
  v[12] = "4";
  v[16] = "89ab"[parseInt(v[16], 16) % 4];
  const s = v.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

// The same shape the program builder and the MCP validateStructure write.
export function toStructure(program) {
  return {
    days: program.days.map((d, di) => ({
      day_id: stableUuid(`${program.name}|d${di}`),
      kind: d.kind,
      label: d.label,
      groups: d.kind === "rest" ? [] : d.groups.map((g, gi) => ({
        group_id: stableUuid(`${program.name}|d${di}|g${gi}`),
        type: g.type ?? "straight",
        exercises: g.exercises.map((ex, ei) => {
          const exercise_id = stableUuid(`${program.name}|d${di}|g${gi}|e${ei}`);
          if (ex.type === "cardio") {
            return {
              exercise_id, name: ex.name, type: "cardio", demo_media_url: null,
              cardio: {
                modality: ex.cardio.modality,
                target_duration_min: ex.cardio.target_duration_min ?? null,
                target_distance: ex.cardio.target_distance ?? null,
                target_distance_unit: ex.cardio.target_distance_unit ?? "mi",
                target_intensity_rpe: ex.cardio.target_intensity_rpe ?? null,
              },
              sets: [{ set_index: 0, target_reps: null, target_weight: null, notes: ex.cardio.notes ?? null }],
            };
          }
          return {
            exercise_id, name: ex.name, type: "strength", demo_media_url: null,
            sets: ex.sets.map((s, si) => ({
              set_index: si, target_reps: String(s.target_reps), target_weight: null, notes: s.notes ?? null,
            })),
          };
        }),
      })),
    })),
  };
}

const jsonLiteral = (value) => {
  const text = JSON.stringify(value);
  if (text.includes("$json$")) throw new Error("starter content may not contain $json$");
  return `$json$${text}$json$::jsonb`;
};
const textLiteral = (s) => `'${String(s).replaceAll("'", "''")}'`;

export function buildProgramsSql(source) {
  const rows = source.programs
    .map((p) => `    (${textLiteral(p.name)}, ${jsonLiteral(toStructure(p))})`)
    .join(",\n");
  return `-- Coach app sample programs. SAMPLE CONTENT, EDIT BEFORE USE.
-- Generated from starter-content/programs.json by scripts/build-starter-sql.mjs. Do not edit by hand.
--
-- ${source._notice}
--
-- How to use: finish SETUP.md first (you can open the coach console). Then paste this whole
-- file into a new, empty Supabase SQL Editor tab and click Run. It adds ${source.programs.length} programs whose
-- names start with "Sample:" to your own coach account (the "owner" account from SETUP.md
-- step 25). Running it again adds nothing new. To remove one, open it in the app under
-- More > Programs and archive it.

do $starter$
declare
  owner_tenant uuid;
begin
  select id into owner_tenant from public.tenants where slug = 'owner';
  if owner_tenant is null then
    raise exception 'No coach account yet. Finish SETUP.md step 25 first, then run this again.';
  end if;

  insert into public.programs (tenant_id, name, structure, is_default)
  select owner_tenant, v.name, v.structure, false
  from (values
${rows}
  ) as v(name, structure)
  where not exists (
    select 1 from public.programs p where p.tenant_id = owner_tenant and p.name = v.name
  );
end
$starter$;

select name as "Sample programs in your account"
from public.programs
where tenant_id = (select id from public.tenants where slug = 'owner') and name like 'Sample:%'
order by name;
`;
}

export function buildMealPlanSql(plan) {
  const meals = plan.meals.map((m) => ({
    name: m.name, note: m.note ?? "",
    items: m.items.map((it) => ({ food: it.food, qty: it.qty, kcal: it.kcal })),
  }));
  return `-- Coach app sample meal plan. SAMPLE CONTENT, EDIT BEFORE USE.
-- Generated from starter-content/meal-plan-template.json by scripts/build-starter-sql.mjs. Do not edit by hand.
--
-- ${plan._notice}
--
-- How to use: add the client in the app first (Clients > Add client). Paste this whole file into
-- a new, empty Supabase SQL Editor tab, replace client@example.com below with that client's
-- email (keep the quote marks), and click Run. It saves the plan as a DRAFT on that client:
-- the client cannot see it. Open the client in the app, edit the plan to fit them, and release
-- it from there. If the client already has a meal plan, this changes nothing.

do $starter$
declare
  client_email text := 'client@example.com';
  owner_tenant uuid;
  target_client uuid;
begin
  select id into owner_tenant from public.tenants where slug = 'owner';
  if owner_tenant is null then
    raise exception 'No coach account yet. Finish SETUP.md step 25 first, then run this again.';
  end if;
  select c.id into target_client from public.clients c
   where c.tenant_id = owner_tenant and lower(c.email) = lower(client_email)
   limit 1;
  if target_client is null then
    raise exception 'No client with the email % in your account. Add the client in the app first, or check the email.', client_email;
  end if;

  insert into public.meal_plans (tenant_id, client_id, title, calories, protein_g, fat_g, carb_g, meals, notes, status)
  values (owner_tenant, target_client, ${textLiteral(plan.title)}, ${plan.calories}, ${plan.protein_g}, ${plan.fat_g}, ${plan.carb_g},
          ${jsonLiteral(meals)},
          ${textLiteral(plan.notes)}, 'draft')
  on conflict (tenant_id, client_id) do nothing;
end
$starter$;

select c.email as client, m.title, m.status
from public.meal_plans m join public.clients c on c.id = m.client_id
where m.tenant_id = (select id from public.tenants where slug = 'owner')
order by m.updated_at desc
limit 5;
`;
}

export function buildAll() {
  const programs = JSON.parse(readFileSync(join(dir, "programs.json"), "utf8"));
  const plan = JSON.parse(readFileSync(join(dir, "meal-plan-template.json"), "utf8"));
  return {
    "sample_programs.sql": buildProgramsSql(programs),
    "sample_meal_plan.sql": buildMealPlanSql(plan),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [name, text] of Object.entries(buildAll())) {
    writeFileSync(join(dir, name), text);
    console.log(`wrote starter-content/${name}`);
  }
}
