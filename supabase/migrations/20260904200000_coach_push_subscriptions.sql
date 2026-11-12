-- Coach-side Web Push (2026-09-04, the platform owner: "I need notifications button on my ui").
--
-- Clients have had push since P4 (clients.push_subscription + send-nudge). Coaches had
-- nowhere to store a subscription and nothing that would ever send them one. This adds:
--   1. coach_push_subscriptions — one row per (coach, device). RLS: a coach manages only
--      their own rows inside their own tenant. Nobody else can read an endpoint.
--   2. A trigger on the two client events a coach actually wants a buzz for — a client
--      message and a submitted check-in — that asks the notify-coach edge function to
--      send. The DB cannot do Web Push itself (VAPID signing lives with the function).
--
-- Transport: pg_net (async; the client's write never waits on the push) with the same
-- vault bearer the pg_cron jobs already use ('cron_reconcile_bearer'); notify-coach
-- checks it as CRON_SECRET exactly like license-reconcile. No new secret anywhere.
-- Failure posture: the trigger swallows every error — a notification must never fail
-- the client's message or check-in.

create table if not exists public.coach_push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  endpoint      text not null,
  subscription  jsonb not null,
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  unique (user_id, endpoint)
);

create index if not exists coach_push_subscriptions_tenant_live
  on public.coach_push_subscriptions (tenant_id) where revoked_at is null;

alter table public.coach_push_subscriptions enable row level security;

drop policy if exists cps_own_select on public.coach_push_subscriptions;
create policy cps_own_select on public.coach_push_subscriptions
  for select to public
  using (user_id = auth.uid() and tenant_id = current_tenant_id() and current_app_role() = 'coach');

drop policy if exists cps_own_insert on public.coach_push_subscriptions;
create policy cps_own_insert on public.coach_push_subscriptions
  for insert to public
  with check (user_id = auth.uid() and tenant_id = current_tenant_id() and current_app_role() = 'coach');

drop policy if exists cps_own_update on public.coach_push_subscriptions;
create policy cps_own_update on public.coach_push_subscriptions
  for update to public
  using (user_id = auth.uid() and tenant_id = current_tenant_id() and current_app_role() = 'coach')
  with check (user_id = auth.uid() and tenant_id = current_tenant_id() and current_app_role() = 'coach');

drop policy if exists cps_own_delete on public.coach_push_subscriptions;
create policy cps_own_delete on public.coach_push_subscriptions
  for delete to public
  using (user_id = auth.uid() and tenant_id = current_tenant_id() and current_app_role() = 'coach');

-- ---------------------------------------------------------------------------------
-- Trigger: client event → notify-coach (pg_net, vault bearer). SECURITY DEFINER so it
-- can read the vault and call net.* on behalf of a plain authenticated insert.
-- ---------------------------------------------------------------------------------
create or replace function public.notify_coach_of_client_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind   text;
  v_secret text;
  v_url    text;
begin
  if tg_table_name = 'messages' then
    if new.sender_role::text <> 'client' then
      return new;                       -- coach → client messages are not events for the coach
    end if;
    v_kind := 'message';
  elsif tg_table_name = 'checkins' then
    v_kind := 'checkin';
  else
    return new;
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'cron_reconcile_bearer'
   limit 1;
  if v_secret is null then
    return new;                         -- no bearer, no call; never block the write
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name = 'project_url'
   limit 1;
  if v_url is null then
    return new;                         -- project URL not configured; never block the write
  end if;

  perform net.http_post(
    url     := v_url || '/functions/v1/notify-coach',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body    := jsonb_build_object(
      'kind',      v_kind,
      'tenant_id', new.tenant_id,
      'client_id', new.client_id,
      'row_id',    new.id
    )
  );
  return new;
exception when others then
  return new;                           -- a notification must never fail the client's write
end
$$;

revoke all on function public.notify_coach_of_client_event() from public;

drop trigger if exists trg_notify_coach_message on public.messages;
create trigger trg_notify_coach_message
  after insert on public.messages
  for each row execute function public.notify_coach_of_client_event();

drop trigger if exists trg_notify_coach_checkin on public.checkins;
create trigger trg_notify_coach_checkin
  after insert on public.checkins
  for each row execute function public.notify_coach_of_client_event();
