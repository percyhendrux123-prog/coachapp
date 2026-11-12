-- Pentest F3 (2026-09-05). Remove the anon EXECUTE grant from four coach/client
-- mutator RPCs. Each already refuses an anonymous caller (they require
-- auth.uid() / current_client_id(), which is null for anon), none is referenced by
-- any RLS policy (verified against pg_policies), and no pre-login flow calls them.
-- So this removes unnecessary attack surface with zero behavior change, and is
-- reversible by re-granting. The legitimately-anon helpers used inside RLS
-- (current_tenant_id, current_app_role, tenant_is_suspended, get_app_config) and
-- the trigger functions are deliberately left untouched.
revoke execute on function public.create_coach_client(text, text, text, text, text, date, text) from anon;
revoke execute on function public.send_coach_message(uuid, text) from anon;
revoke execute on function public.adjust_my_schedule(uuid, uuid[], text, text) from anon;
revoke execute on function public.set_brief_slide_order(uuid[], uuid) from anon;
