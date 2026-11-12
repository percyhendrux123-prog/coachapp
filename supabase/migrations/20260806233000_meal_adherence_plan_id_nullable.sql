-- Allow meal adherence logs without a structured client_meal_plans row.
-- Legacy PDF/JSON meal plans (meal_plans) and simple day logging need this.
-- Unique key remains (client_id, log_date, slot_index).

alter table public.meal_adherence_logs
  alter column plan_id drop not null;

comment on column public.meal_adherence_logs.plan_id is
  'Optional FK to client_meal_plans when logging against a structured plan. Null for legacy/simple slot logs.';
