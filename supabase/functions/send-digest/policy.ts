import { OWNER_TENANT_SLUG } from "../_shared/owner.ts";

export type OwnerTenant = { id: string; slug: string };

export function requireOwnerTenant(tenant: OwnerTenant | null | undefined): OwnerTenant {
  if (!tenant?.id || tenant.slug !== OWNER_TENANT_SLUG) throw new Error("Owner tenant not found");
  return tenant;
}

export function filterOwnerDigestRows<T extends { tenant_id: string }>(rows: T[], owner: OwnerTenant): T[] {
  const required = requireOwnerTenant(owner);
  return rows.filter((row) => row.tenant_id === required.id);
}
