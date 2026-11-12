-- Slice 4 of the original design notes (not included) — retire what Slices 1–3 superseded.
--
-- The intake-onboard edge function (2026-07-31) was never wired to a button and never ran on
-- a real client. Its release logic lives on the tokenized path now (release_client, Slice 3);
-- its status ledger is derived now (client_onboarding_facts, Slice 1). The function directory
-- is deleted from the repo in the same commit as this file, and the deployed function is
-- deleted on the platform owner's word (supabase functions delete intake-onboard). Audit expects 27.
--
-- DROPPED here: the four functions whose ONLY caller was intake-onboard, verified live on
-- 2026-09-07 by reading pg_proc for callers and the repo for rpc() calls:
--   release_client_onboarding(uuid)          the pipeline's release door
--   check_client_onboarding_readiness(uuid)  called only by release_client_onboarding
--   assert_coach_owns_onboarding(uuid)       called only by the two above
--   intake_match_or_create_client(uuid)      the pipeline's entry (intake_submissions → client)
--
-- KEPT, deliberately — the plan said "drop client_onboarding + blocker RPCs if nothing else
-- reads them", and something does:
--   client_onboarding (table, 1 row: the 2026-07-31 prepared record)  written by
--     confirm_client_body_metrics, assemble_client_meal_plan_core and (via the helpers below)
--     the live meal-plan assembly; read by the MCP tools get_client_onboarding and
--     get_roster_state as a legacy "pipeline state" section.
--   onboarding_add_blocker / onboarding_clear_blockers / onboarding_recompute_stage
--     called by the live functions above.
-- Removing those is a separate change that edits three live functions and two connector
-- tools; it is not "retire the superseded pipeline", so it is not done here.

drop function if exists public.release_client_onboarding(uuid);
drop function if exists public.check_client_onboarding_readiness(uuid);
drop function if exists public.assert_coach_owns_onboarding(uuid);
drop function if exists public.intake_match_or_create_client(uuid);

comment on table public.client_onboarding is
  'LEGACY (Slice 4, 2026-09-07): written by the retired intake-onboard pipeline and still touched by confirm_client_body_metrics / assemble_client_meal_plan_core. Not the status view — that is client_onboarding_facts(). Do not build on this table.';
