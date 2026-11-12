-- link_client_by_email() completes the invite the same way claim_client_invite() does.
--
-- The auth.users triggers (link_client_on_insert / link_client_on_confirm) call
-- link_client_by_email() the moment an invited client confirms their email by entering
-- their first code. That runs BEFORE the claim page calls claim_client_invite(), which
-- then sees the row already attached and answers 'already_yours' without touching it.
-- Before this file the row was attached but kept status 'invited' and a live invite
-- token: the coach's roster said "Invited" for a client who was already training.
--
-- Now linking by a confirmed email also flips 'invited' to 'active', as
-- claim_client_invite() does. Other statuses (paused, archived) are left alone. The invite
-- token is deliberately kept: the claim page calls claim_client_invite() right after, and
-- with the token still on the row it answers 'already_yours' (the "you're all set"
-- screen) instead of 'invalid'. The row is attached, so the token cannot attach anyone
-- else (any other account gets 'already_claimed'), and the next invite replaces it. Only the trigger path runs this, and the triggers
-- fire only on a confirmed email, so the mailbox proof is unchanged.
create or replace function public.link_client_by_email(p_user_id uuid, p_email text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_linked int;
  v_tenant uuid;
begin
  if p_email is null or p_user_id is null then return 0; end if;
  -- clients_user_unique: one auth user <-> at most one clients row (schema-enforced).
  -- An already-linked user never claims another row; a multi-tenant email links the
  -- oldest matching row only.
  if exists (select 1 from public.clients where client_user_id = p_user_id) then
    return 0;
  end if;

  update public.clients c
     set client_user_id    = p_user_id,
         status            = case when c.status = 'invited' then 'active'::client_status else c.status end,
         updated_at        = now()
   where c.id = (
     select id from public.clients
      where client_user_id is null and lower(email) = lower(p_email)
      order by joined_at asc limit 1
   );
  get diagnostics v_linked = row_count;

  if v_linked > 0 and not exists (select 1 from public.profiles where user_id = p_user_id) then
    select tenant_id into v_tenant
      from public.clients where client_user_id = p_user_id limit 1;
    insert into public.profiles (user_id, role, tenant_id)
    values (p_user_id, 'client', v_tenant)
    on conflict (user_id) do nothing;
  end if;
  return v_linked;
end;
$function$;
