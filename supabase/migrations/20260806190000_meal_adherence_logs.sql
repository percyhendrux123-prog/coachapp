-- WP-13 minimal: meal adherence log (logged / skipped / fallback).
-- One row per client per calendar day per meal slot on an assigned plan.
-- Clients write their own rows; coaches read their tenant. No free-form food diary.

create table if not exists public.meal_adherence_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  plan_id uuid not null references public.client_meal_plans(id) on delete cascade,
  log_date date not null,
  slot_index integer not null check (slot_index >= 0 and slot_index < 16),
  slot_label text,
  status text not null check (status = any (array['logged'::text, 'skipped'::text, 'fallback'::text])),
  meal_id uuid references public.meals(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, log_date, slot_index)
);

create index if not exists mal_client_date_idx
  on public.meal_adherence_logs (client_id, log_date desc);

create index if not exists mal_tenant_date_idx
  on public.meal_adherence_logs (tenant_id, log_date desc);

comment on table public.meal_adherence_logs is
  'Client meal adherence: logged (ate the assigned meal), skipped, or fallback (bad-week meal). Not a free-form food diary.';

alter table public.meal_adherence_logs enable row level security;

drop policy if exists mal_client_all on public.meal_adherence_logs;
create policy mal_client_all on public.meal_adherence_logs
  for all
  using (client_id = public.current_client_id())
  with check (
    client_id = public.current_client_id()
    and tenant_id = public.current_tenant_id()
  );

drop policy if exists mal_coach_read on public.meal_adherence_logs;
create policy mal_coach_read on public.meal_adherence_logs
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_app_role() = 'coach'
  );

-- Keep updated_at honest on upsert.
create or replace function public.meal_adherence_logs_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists meal_adherence_logs_touch on public.meal_adherence_logs;
create trigger meal_adherence_logs_touch
  before update on public.meal_adherence_logs
  for each row execute function public.meal_adherence_logs_touch();
