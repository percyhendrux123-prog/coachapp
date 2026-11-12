// Stripe configuration is deployment-specific. Unconfigured mappings fail closed.
type Tier = "entry" | "standard";
const env = (name: string): string => Deno.env.get(name)?.trim() || "";
const priceMap = (): Record<string, Tier> => Object.fromEntries(
  (["entry", "standard"] as const).flatMap((tier) => {
    const id = env(`STRIPE_PRICE_${tier.toUpperCase()}`);
    return id ? [[id, tier]] : [];
  }),
);
const productMap = (): Record<string, Tier> => Object.fromEntries(
  (["entry", "standard"] as const).flatMap((tier) =>
    env(`STRIPE_PRODUCTS_${tier.toUpperCase()}`).split(",").map((id) => id.trim()).filter(Boolean).map((id) => [id, tier])
  ),
);
// Lazy maps allow tests and long-lived workers to read the current configuration.
function lazyMap(read: () => Record<string, Tier>): Record<string, Tier> {
  return new Proxy({} as Record<string, Tier>, {
    get: (_target, key) => typeof key === "string" ? read()[key] : undefined,
    ownKeys: () => Object.keys(read()),
    getOwnPropertyDescriptor: (_target, key) => typeof key === "string" && key in read()
      ? { enumerable: true, configurable: true, value: read()[key] } : undefined,
  });
}
export const COACHING_TIER_BY_PRICE = lazyMap(priceMap);
export const COACHING_PRICE_BY_TIER = {
  get entry() { return env("STRIPE_PRICE_ENTRY"); },
  get standard() { return env("STRIPE_PRICE_STANDARD"); },
};
export const COACHING_PRICE_IDS = Object.keys(priceMap());
// Gate subscriptions by product: negotiated per-client prices can rotate independently.
export const COACHING_TIER_BY_PRODUCT = lazyMap(productMap);
export const tierForProduct = (productId?: string | null): Tier | null =>
  productId ? productMap()[productId] ?? null : null;
export const tierForPrice = (priceId?: string | null): Tier | null =>
  priceId ? priceMap()[priceId] ?? null : null;
export const WHITE_LABEL_LICENSE_PRICE = env("STRIPE_PRICE_LICENSE");
export const HOSTING_MONTHLY_PRICE = env("STRIPE_PRICE_HOSTING");
export const SYSTEM_ONE_TIME_PRICE = env("STRIPE_PRICE_SELF_SERVE");
export const SYSTEM_AUTOMATIC_TAX = false;
export const SYSTEM_CHECKOUT_KIND = "self_serve_plan";
// Promo codes are honored only when their coupon explicitly permits this product.
export const SYSTEM_PROMO_ALLOW_KEY = "system_ok";
