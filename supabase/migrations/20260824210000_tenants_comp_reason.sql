-- ============================================================================
-- Tenants can be deliberately comped (manual arrangement, not Stripe-billed)
-- without license-reconcile reading that as a silent gap.
--
-- 20260824170000 made license-reconcile report every licensed tenant with no
-- subscription_id as unhealthy — correct for an accidental gap, wrong for a
-- deliberate one. Some tenants are on a manual arrangement on purpose; this
-- column records that so the reconcile job does not alarm on them. It changes
-- no access.
-- ============================================================================

alter table public.tenants add column if not exists comp_reason text;

comment on column public.tenants.comp_reason is
  'Non-null = this tenant is deliberately not billed through Stripe (manual/comp arrangement) instead of an accidental gap. Set by the platform owner directly, never inferred. license-reconcile excludes a tenant with this set from its "unverifiable licensed tenant" unhealthy flag, but still reports it by name so the arrangement stays visible, not hidden.';

