-- ============================================================================
-- Gate C: only block on restriction kinds that carry real risk if ignored.
-- ============================================================================
--
-- WHY
--
-- Gate C in assemble_client_meal_plan() currently hard-blocks the ENTIRE plan
-- whenever the meal library has no tag for ANY stated restriction except
-- kind='preference'. That treats a client's food DISLIKE or plain EXCLUSION
-- exactly like a stated diet or a physical intolerance -- but those are not
-- the same risk.
--
-- Cheryl Moye's case was fixed narrowly on 2026-07-31 by adding library
-- vocabulary for her six specific foods (20260731173000). That unblocked her,
-- but did nothing for the next client who dislikes some other uncatalogued
-- food -- they would still be held at a locked door over a library gap, which
-- is exactly the shape the coach ruled against: "a library gap must never present
-- as a client constraint."
--
-- THE SPLIT (the coach's approved asymmetry, applied generally now instead of
-- per-client)
--
--   kind IN ('pattern','intolerance')   -- a stated diet (vegan, halal, keto)
--     or a reported physical reaction. Ignoring these has real consequences.
--     STILL HARD-BLOCKS when the library can't express it.
--
--   kind IN ('exclusion','dislike')     -- "I don't eat X" / "I don't like X"
--     with no clinical weight (an actual allergy is a different table --
--     client_allergies -- and Gate B/B2 already hold it strictly). Assembly
--     now PROCEEDS, and the gap is reported at 'review' severity so the coach
--     sees it and can build the plan around it or add the food to the
--     library -- but a client is never held hostage to our own cataloguing.
--
--   kind = 'preference'                 -- already advisory-only, unchanged.
--
-- Nothing here touches Gate B, Gate B2, or Gate D. No allergy-safety behavior
-- changes. Additive and corrective only: a new report code
-- ('dietary_restriction_gap_reported') is added to the clear-on-success list
-- alongside the existing ones, and the plan message is explicit that these
-- foods were NOT filtered out -- silence would be worse than the old hard
-- block, because at least the block was loud.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assemble_client_meal_plan(p_client_id uuid, p_meals_per_day integer DEFAULT NULL::integer, p_rotation_days integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c                public.clients%rowtype;
  v_onb_id         uuid;
  v_prep           boolean;
  v_unconfirmed    text[];
  v_unmapped       text[];
  v_diet_unmapped  text[];
  v_diet_advisory  text[];
  v_excluded_tags  text[];
  v_required_tags  text[];
  v_macros         jsonb;
  v_kcal           numeric;
  v_protein        numeric;
  v_fat            numeric;
  v_carb           numeric;
  v_mpd            int;
  v_days           int;
  v_pool_n         int;
  v_badweek_n      int;
  v_plan_id        uuid;
  v_assumptions    text[] := '{}';
  d                int;
  s                int;
  v_slot_id        uuid;
  v_meal           record;
  v_target_kcal    numeric;
  v_prot_ratio     numeric;
  v_delivered_prot numeric;
  v_servings       numeric;
  v_used           uuid[];
  v_slots_made     int := 0;
  v_missing_fb     int := 0;
begin
  perform public.assert_coach_owns_client(p_client_id);
  select * into c from public.clients where id = p_client_id;
  if not found then return jsonb_build_object('status','error','reason','client_not_found'); end if;

  select id into v_onb_id from public.client_onboarding
   where client_id = p_client_id order by created_at desc limit 1;

  -- Gate A: the lifestyle/prep switch must be stated.
  if c.client_type is null then
    if v_onb_id is not null then perform public.onboarding_add_blocker(v_onb_id,
      'client_type_unstated',
      'Cannot assemble: the client is neither marked lifestyle nor prep. The two produce '
      'different plans (fixed repetition vs rotation with fallbacks); defaulting would be a '
      'guess about how this person trains and eats.', 'block'); end if;
    return jsonb_build_object('status','blocked','reason','client_type_unstated');
  end if;
  v_prep := (c.client_type = 'prep');

  -- Gate B: allergy safety.
  select array_agg(distinct coalesce(nullif(allergen_label,''), allergen_key))
    into v_unconfirmed
    from public.client_allergies
   where client_id = p_client_id and active
     and (needs_review or confidence = 'parsed');

  if v_unconfirmed is not null and array_length(v_unconfirmed,1) > 0 then
    if v_onb_id is not null then perform public.onboarding_add_blocker(v_onb_id,
      'allergy_unreviewed',
      format('Not assembled. These allergies are still machine-parsed from free text and have '
             'not been confirmed with the client: %s. Confirm each one (set confidence to '
             'coach_confirmed or client_confirmed and clear needs_review), then re-run. An '
             'automated meal plan built on a regex-parsed allergy is a safety claim that '
             'cannot be made.', array_to_string(v_unconfirmed, ', ')), 'block'); end if;
    return jsonb_build_object('status','blocked','reason','allergy_unreviewed',
      'allergies', to_jsonb(v_unconfirmed));
  end if;

  select array_agg(distinct ca.allergen_key) into v_unmapped
    from public.client_allergies ca
   where ca.client_id = p_client_id and ca.active
     and not exists (select 1 from public.allergen_tag_crosswalk x
                      where x.allergen_key = ca.allergen_key);

  if v_unmapped is not null and array_length(v_unmapped,1) > 0 then
    if v_onb_id is not null then perform public.onboarding_add_blocker(v_onb_id,
      'allergen_not_representable',
      format('Not assembled. The meal library has never been reviewed for: %s. Every published '
             'meal is marked reviewed against fourteen allergen tags, and these are not among '
             'them — so "no meal is tagged with it" is a fact about the library, not evidence '
             'the food is safe. Build this plan by hand, or review the library for these '
             'allergens and add the crosswalk rows.',
             array_to_string(v_unmapped, ', ')), 'block'); end if;
    return jsonb_build_object('status','blocked','reason','allergen_not_representable',
      'allergen_keys', to_jsonb(v_unmapped));
  end if;

  -- Gate C: dietary restrictions the library cannot express.
  -- Only kinds with real risk if silently ignored still hard-block: a stated
  -- diet ('pattern') or a reported physical reaction ('intolerance'). A plain
  -- dislike or exclusion is not a safety fact, so an unrepresented one is
  -- reported below (post-success, 'review' severity) instead of holding the
  -- whole plan shut over our own cataloguing gap.
  select array_agg(distinct r.restriction_key) into v_diet_unmapped
    from public.client_dietary_restrictions r
   where r.client_id = p_client_id and r.active
     and r.kind in ('pattern','intolerance')
     and not exists (select 1 from public.meal_tags t where t.key = r.restriction_key)
     and not exists (select 1 from public.allergen_tag_crosswalk x where x.allergen_key = r.restriction_key);

  if v_diet_unmapped is not null and array_length(v_diet_unmapped,1) > 0 then
    if v_onb_id is not null then perform public.onboarding_add_blocker(v_onb_id,
      'dietary_restriction_not_representable',
      format('Not assembled. These stated diets or intolerances have no equivalent in the meal '
             'library, so the filter cannot honour them: %s. A plan that quietly ignores a '
             'diet or a reported reaction the client wrote down is worse than no plan. Handle '
             'by hand, or mark the restriction inactive if it no longer applies.',
             array_to_string(v_diet_unmapped, ', ')), 'block'); end if;
    return jsonb_build_object('status','blocked','reason','dietary_restriction_not_representable',
      'restriction_keys', to_jsonb(v_diet_unmapped));
  end if;

  select array_agg(distinct r.restriction_key) into v_diet_advisory
    from public.client_dietary_restrictions r
   where r.client_id = p_client_id and r.active
     and r.kind in ('exclusion','dislike')
     and not exists (select 1 from public.meal_tags t where t.key = r.restriction_key)
     and not exists (select 1 from public.allergen_tag_crosswalk x where x.allergen_key = r.restriction_key);

  -- Gate D: macro targets must rest on real body metrics.
  if c.weight_kg is null or c.height_cm is null or c.age is null or c.sex is null then
    if v_onb_id is not null then perform public.onboarding_add_blocker(v_onb_id,
      'missing_body_metrics',
      format('Not assembled. Macro targets need real numbers and these are empty on the client '
             'record: %s. The existing generator silently substitutes 80 kg / 178 cm / age 30 / '
             'male when they are missing, which produces a calorie target that looks '
             'authoritative and belongs to nobody.',
             concat_ws(', ',
               case when c.weight_kg is null then 'weight' end,
               case when c.height_cm is null then 'height' end,
               case when c.age       is null then 'age' end,
               case when c.sex       is null then 'sex' end)), 'block'); end if;
    return jsonb_build_object('status','blocked','reason','missing_body_metrics');
  end if;

  select pd.macros into v_macros from public.program_drafts pd
   where pd.client_id = p_client_id and pd.macros ? 'calories'
   order by pd.generated_at desc limit 1;

  if v_macros is null then
    if v_onb_id is not null then perform public.onboarding_add_blocker(v_onb_id,
      'no_macro_targets',
      'Not assembled. No program draft with computed macros exists for this client yet, so '
      'there is no calorie or protein target to build the plan against. Generate the program '
      'draft first — the pipeline normally does this before the meal step.', 'block'); end if;
    return jsonb_build_object('status','blocked','reason','no_macro_targets');
  end if;

  v_kcal    := (v_macros->>'calories')::numeric;
  v_protein := (v_macros->>'protein_g')::numeric;
  v_fat     := (v_macros->>'fat_g')::numeric;
  v_carb    := (v_macros->>'carb_g')::numeric;

  v_mpd := p_meals_per_day;
  if v_mpd is null then
    select nullif(regexp_replace(coalesce(kv.value, ''), '\D', '', 'g'), '')::int
      into v_mpd
      from public.intake_submissions sub
      cross join lateral jsonb_each_text(sub.answers) kv
     where sub.client_id = p_client_id
       and (kv.key = 'meals_per_day'
            or lower(kv.key) like '%meal%per%day%'
            or lower(kv.key) like '%how many meals%')
       and coalesce(kv.value,'') ~ '\d'
     order by sub.submitted_at desc limit 1;
  end if;
  if v_mpd is null or v_mpd < 1 or v_mpd > 8 then
    v_mpd := 4;
    v_assumptions := array_append(v_assumptions, 'meals_per_day was not stated on the intake; drafted at 4.'::text);
  end if;

  v_days := coalesce(p_rotation_days, case when v_prep then 1 else 7 end);

  select array_agg(distinct x.tag_key) into v_excluded_tags
    from public.allergen_tag_crosswalk x
   where x.allergen_key in (
     select ca.allergen_key from public.client_allergies ca
      where ca.client_id = p_client_id and ca.active
     union
     select r.restriction_key from public.client_dietary_restrictions r
      where r.client_id = p_client_id and r.active and r.kind in ('exclusion','dislike'));
  v_excluded_tags := coalesce(v_excluded_tags, '{}');

  select array_agg(distinct r.restriction_key) into v_required_tags
    from public.client_dietary_restrictions r
    join public.meal_tags t on t.key = r.restriction_key and t.kind = 'diet'
   where r.client_id = p_client_id and r.active and r.kind = 'pattern';
  v_required_tags := coalesce(v_required_tags, '{}');

  -- ON COMMIT DROP does not fire between two calls inside one transaction.
  drop table if exists _pool;
  create temp table _pool on commit drop as
  select m.id, m.name, m.category, m.kcal, m.protein_g, m.fat_g, m.carb_g,
         m.disruption_floor, m.downgrade_to_meal_id,
         md5(m.id::text || p_client_id::text) as ord
    from public.meals m
   where m.status = 'published'
     and m.macro_state = 'computed'
     and m.allergen_review_state = 'reviewed'
     and (m.tenant_id is null or m.tenant_id = c.tenant_id)
     and (case when v_prep then m.serves_prep else m.serves_lifestyle end)
     and coalesce(m.kcal,0) > 0
     and not exists (
       select 1 from public.meal_tag_map mm join public.meal_tags t on t.id = mm.tag_id
        where mm.meal_id = m.id and t.key = any(v_excluded_tags))
     and not exists (
       select 1 from unnest(v_required_tags) rq
        where not exists (
          select 1 from public.meal_tag_map mm join public.meal_tags t on t.id = mm.tag_id
           where mm.meal_id = m.id and t.key = rq));

  select count(*) into v_pool_n from _pool;
  select count(*) into v_badweek_n from _pool where disruption_floor >= 3;

  if v_pool_n < v_mpd then
    if v_onb_id is not null then perform public.onboarding_add_blocker(v_onb_id,
      'meal_pool_too_thin',
      format('Not assembled. After applying this client''s confirmed allergies and '
             'restrictions, only %s reviewed library meals remain — fewer than the %s meals a '
             'day the plan calls for. This is a gap in the library, not in the client.',
             v_pool_n, v_mpd), 'block'); end if;
    return jsonb_build_object('status','blocked','reason','meal_pool_too_thin',
      'safe_meals', v_pool_n, 'meals_per_day', v_mpd);
  end if;

  update public.client_meal_plans set status = 'archived', updated_at = now()
   where client_id = p_client_id and status = 'draft';

  insert into public.client_meal_plans (
    tenant_id, client_id, title, status, assembly_mode, rotation_days, substitution_policy,
    target_calories, target_protein_g, target_fat_g, target_carb_g, meals_per_day, notes)
  values (c.tenant_id, p_client_id,
    format('%s — %s plan — %s', c.display_name,
           case when v_prep then 'prep' else 'lifestyle' end, to_char(now(),'YYYY-MM-DD')),
    'draft',
    case when v_prep then 'fixed' else 'rotation' end,
    v_days,
    case when v_prep then 'locked' else 'open' end,
    v_kcal, v_protein, v_fat, v_carb, v_mpd,
    case when array_length(v_assumptions,1) > 0
         then 'Drafted assumptions: ' || array_to_string(v_assumptions, ' ') else null end)
  returning id into v_plan_id;

  v_target_kcal := v_kcal / v_mpd;
  -- Servings are scaled to hit calories, so what actually decides whether the
  -- protein target lands is each meal's protein DENSITY, not its absolute grams.
  v_prot_ratio  := v_protein / nullif(v_kcal, 0);

  for d in 0 .. v_days - 1 loop
    v_used := '{}';
    for s in 0 .. v_mpd - 1 loop
      select p.* into v_meal from _pool p
       where p.id <> all(v_used)
         and (s > 0 or p.category = 'breakfast' or v_days = 1)
       order by
         case when s = 0 and p.category = 'breakfast' then 0 else 1 end,
         round(abs((p.protein_g / nullif(p.kcal,0)) - v_prot_ratio) / nullif(v_prot_ratio,0), 2),
         abs(p.kcal - v_target_kcal),
         (p.ord || d::text)
       limit 1;

      if not found then
        select p.* into v_meal from _pool p where p.id <> all(v_used)
         order by round(abs((p.protein_g / nullif(p.kcal,0)) - v_prot_ratio) / nullif(v_prot_ratio,0), 2),
                  abs(p.kcal - v_target_kcal), (p.ord || d::text) limit 1;
      end if;
      exit when not found;

      v_used := v_used || v_meal.id;
      v_servings := round(least(greatest(v_target_kcal / v_meal.kcal, 0.5), 3.0) * 4) / 4.0;

      insert into public.client_meal_plan_slots
        (plan_id, tenant_id, client_id, day_index, slot_index, slot_label, meal_id, servings, is_locked)
      values (v_plan_id, c.tenant_id, p_client_id, d, s,
              case when s = 0 then 'Meal 1' else format('Meal %s', s + 1) end,
              v_meal.id, v_servings, v_prep)
      returning id into v_slot_id;
      v_slots_made := v_slots_made + 1;

      if not v_prep then
        insert into public.client_meal_plan_slot_options (slot_id, tenant_id, client_id, meal_id, position)
        select v_slot_id, c.tenant_id, p_client_id, o.id, row_number() over (order by o.dist)
          from (
            select p.id, abs(p.kcal - v_meal.kcal) as dist
              from _pool p
             where p.id <> v_meal.id
               and p.kcal between v_meal.kcal * 0.75 and v_meal.kcal * 1.25
             order by abs(p.kcal - v_meal.kcal), p.ord limit 2) o;

        insert into public.client_meal_plan_slot_options (slot_id, tenant_id, client_id, meal_id, position)
        select v_slot_id, c.tenant_id, p_client_id, fb.id, 9
          from (
            select coalesce(
                     (select p.id from _pool p
                       where p.id = v_meal.downgrade_to_meal_id and p.disruption_floor >= 3),
                     (select p.id from _pool p
                       where p.disruption_floor >= 3 and p.id <> v_meal.id
                       order by abs(p.kcal - v_meal.kcal), p.ord limit 1)) as id) fb
         where fb.id is not null
           and not exists (select 1 from public.client_meal_plan_slot_options ex
                            where ex.slot_id = v_slot_id and ex.meal_id = fb.id);

        if not exists (
          select 1 from public.client_meal_plan_slot_options op
            join _pool p on p.id = op.meal_id
           where op.slot_id = v_slot_id and p.disruption_floor >= 3)
        then v_missing_fb := v_missing_fb + 1; end if;
      end if;
    end loop;
  end loop;

  -- What the plan actually delivers, per day, against what it promised.
  select round(sum(m.protein_g * sl.servings) / nullif(v_days,0))
    into v_delivered_prot
    from public.client_meal_plan_slots sl join public.meals m on m.id = sl.meal_id
   where sl.plan_id = v_plan_id;

  if v_onb_id is not null and v_delivered_prot is not null
     and v_delivered_prot < v_protein * 0.95 then
    perform public.onboarding_add_blocker(v_onb_id, 'protein_target_not_met',
      format('This plan delivers about %s g protein a day against a %s g target — %s g short. '
             'The library does not contain enough protein-dense meals that survive this client''s '
             'restrictions to reach it. The plan is not wrong; the target is not reachable from the '
             'current pool. Either lower the target or add protein-dense reviewed meals.',
             v_delivered_prot, round(v_protein), round(v_protein - v_delivered_prot)), 'review');
  end if;

  if v_onb_id is not null then
    update public.client_onboarding set meal_plan_id = v_plan_id, updated_at = now()
     where id = v_onb_id;

    -- Everything below is a reason this function previously refused. It just succeeded,
    -- so those reasons are gone; leaving them behind would hold the release gate shut on
    -- a problem that no longer exists.
    perform public.onboarding_clear_blockers(v_onb_id, array[
      'allergy_unreviewed','allergen_not_representable','dietary_restriction_not_representable',
      'missing_body_metrics','no_macro_targets','client_type_unstated','meal_pool_too_thin',
      'meal_assembly_error','no_bad_week_fallback','drafted_assumption','protein_target_not_met',
      'dietary_restriction_gap_reported']);

    if v_diet_advisory is not null and array_length(v_diet_advisory,1) > 0 then
      perform public.onboarding_add_blocker(v_onb_id, 'dietary_restriction_gap_reported',
        format('Assembled, but the meal library cannot yet honour these stated food dislikes or '
               'exclusions, so meals containing them may still appear in this plan: %s. This is a '
               'gap in the library, not the client — review the plan by hand before release, and '
               'add these foods to the library''s vocabulary so future runs filter them '
               'automatically.', array_to_string(v_diet_advisory, ', ')), 'review');
    end if;

    if v_missing_fb > 0 then
      perform public.onboarding_add_blocker(v_onb_id, 'no_bad_week_fallback',
        format('%s of %s slots have no no-kitchen alternate (disruption_floor 3 or 4) that '
               'survives this client''s restrictions. Those slots hold on a good week only. '
               'The library currently has %s reviewed meals at floor 3+ in total.',
               v_missing_fb, v_slots_made, v_badweek_n), 'review');
    end if;

    if array_length(v_assumptions,1) > 0 then
      perform public.onboarding_add_blocker(v_onb_id, 'drafted_assumption',
        array_to_string(v_assumptions, ' '), 'review');
    end if;
  end if;

  return jsonb_build_object(
    'status','ok', 'plan_id', v_plan_id, 'mode', case when v_prep then 'fixed' else 'rotation' end,
    'rotation_days', v_days, 'meals_per_day', v_mpd, 'slots', v_slots_made,
    'safe_pool', v_pool_n, 'bad_week_meals_available', v_badweek_n,
    'slots_without_bad_week_fallback', v_missing_fb,
    'dietary_gaps_reported', to_jsonb(v_diet_advisory),
    'targets', jsonb_build_object('calories', v_kcal, 'protein_g', v_protein,
                                  'fat_g', v_fat, 'carb_g', v_carb),
    'assumptions', to_jsonb(v_assumptions));
end $function$
;
