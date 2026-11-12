export const OWNER_TENANT_SLUG = "owner";

export function isOwnerTenant(tenant) {
  return tenant?.slug === OWNER_TENANT_SLUG;
}

export function whiteLabelOwnedSurfaces(tenant) {
  const owner = isOwnerTenant(tenant);
  return {
    content: owner,
    knowledge: owner,
  };
}
