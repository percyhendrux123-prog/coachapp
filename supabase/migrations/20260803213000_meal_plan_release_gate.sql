-- WP-10: the gate that keeps an unfinished meal plan off a client's screen.
--
-- Before this, "release" on both meal-plan tables was a bare status flip with no data-layer
-- check behind it -- the 18 legacy shells (title "... (PENDING WEIGH-IN)", zero macros, zero
-- meals) could be flipped to 'assigned' by any bug, script, or fat-fingered click, same as the
-- new client_meal_plans row a coach just built by hand. Verified 2026-08-03: today, zero of
-- the 18 shells are assigned and the one real client_meal_plans release (Cheryl Moye) already
-- satisfies every rule below -- this migration closes a real, currently-unexploited hole, it
-- does not fix a live incident.
--
-- Enforced as a trigger, not a CHECK constraint, because "every slot resolves to a published
-- library meal" requires a subquery against another table, which a CHECK constraint cannot
-- express. The rule applies whenever a row's status IS 'assigned' -- not just on the
-- draft->assigned transition -- so editing an already-assigned plan down into incompleteness
-- is blocked exactly the same way a bad release would be. This is deliberately stricter than
-- "check once at release time."

-- ── 1. Legacy meal_plans ──────────────────────────────────────────────────────────────
-- Complete means: real macro targets, and at least one meal actually in the plan. Grounded
-- directly against the data: every one of the 18 shells has all four macro columns null and
-- an empty meals array; all 7 real assigned plans have every column populated. No deeper
-- per-meal validation is enforced here -- meals is free-form jsonb on this legacy table, not
-- a foreign key into the meals library, so "resolves to a library entry" does not apply to it.
create or replace function public.check_meal_plan_release()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'assigned' then
    return new;
  end if;

  if new.calories is null or new.protein_g is null or new.fat_g is null or new.carb_g is null then
    raise exception 'meal_plans %: cannot be assigned without calories, protein_g, fat_g and carb_g all set', new.id
      using errcode = '23514';
  end if;

  if jsonb_array_length(coalesce(new.meals, '[]'::jsonb)) = 0 then
    raise exception 'meal_plans %: cannot be assigned with zero meals', new.id
      using errcode = '23514';
  end if;

  return new;
end $$;

drop trigger if exists meal_plans_release_gate on public.meal_plans;
create trigger meal_plans_release_gate
  before insert or update on public.meal_plans
  for each row execute function public.check_meal_plan_release();

comment on function public.check_meal_plan_release is
  'WP-10 release gate for the legacy meal_plans table. Blocks any row from reaching or '
  'remaining at status=assigned unless macros are set and it carries at least one meal.';

-- ── 2. Structured client_meal_plans ───────────────────────────────────────────────────
-- Complete means: real macro targets, a stated meals_per_day, and day 0 (the one day the
-- app actually renders -- see D2 in the original design notes (not included)) carrying
-- exactly that many slots, every one pointing at a meal that is actually published. A meal
-- with no fallback is NOT a violation -- D5 makes "holds, nothing to downgrade to" a valid,
-- intentional state -- so fallback presence is deliberately not checked here.
create or replace function public.check_client_meal_plan_release()
returns trigger
language plpgsql
as $$
declare
  v_day0_slots     int;
  v_day0_unpublished int;
begin
  if new.status <> 'assigned' then
    return new;
  end if;

  if new.meals_per_day is null or new.meals_per_day < 1 then
    raise exception 'client_meal_plans %: cannot be assigned without a positive meals_per_day', new.id
      using errcode = '23514';
  end if;

  if new.target_calories is null or new.target_protein_g is null
     or new.target_fat_g is null or new.target_carb_g is null then
    raise exception 'client_meal_plans %: cannot be assigned without target_calories, target_protein_g, target_fat_g and target_carb_g all set', new.id
      using errcode = '23514';
  end if;

  select count(*) filter (where s.meal_id is not null),
         count(*) filter (where m.id is null or m.status <> 'published')
    into v_day0_slots, v_day0_unpublished
    from public.client_meal_plan_slots s
    left join public.meals m on m.id = s.meal_id
   where s.plan_id = new.id and s.day_index = 0;

  if v_day0_slots is distinct from new.meals_per_day then
    raise exception 'client_meal_plans %: day 0 has % filled slots, meals_per_day says %', new.id, coalesce(v_day0_slots, 0), new.meals_per_day
      using errcode = '23514';
  end if;

  if v_day0_unpublished > 0 then
    raise exception 'client_meal_plans %: % of day 0''s slots point at a meal that is missing or not published', new.id, v_day0_unpublished
      using errcode = '23514';
  end if;

  return new;
end $$;

drop trigger if exists client_meal_plans_release_gate on public.client_meal_plans;
create trigger client_meal_plans_release_gate
  before insert or update on public.client_meal_plans
  for each row execute function public.check_client_meal_plan_release();

comment on function public.check_client_meal_plan_release is
  'WP-10 release gate for client_meal_plans. Blocks any row from reaching or remaining at '
  'status=assigned unless targets are set and day 0 is fully filled with published meals.';
