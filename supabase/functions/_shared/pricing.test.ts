import { COACHING_TIER_BY_PRICE, COACHING_PRICE_BY_TIER, COACHING_TIER_BY_PRODUCT, tierForPrice, tierForProduct } from "./pricing.ts";

Deno.test("Stripe maps read configured ids lazily and fail closed when unset", () => {
  const keys = ["STRIPE_PRICE_ENTRY", "STRIPE_PRICE_STANDARD", "STRIPE_PRODUCTS_ENTRY", "STRIPE_PRODUCTS_STANDARD"];
  const saved = keys.map((key) => Deno.env.get(key));
  const eq = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`); };
  try {
    keys.forEach((key) => Deno.env.delete(key));
    eq(tierForPrice("price_test_entry"), null);
    eq(tierForProduct("prod_test_entry"), null);
    eq(Object.keys(COACHING_TIER_BY_PRODUCT), []);
    eq(COACHING_PRICE_BY_TIER.entry, "");
    Deno.env.set("STRIPE_PRICE_ENTRY", "price_test_entry");
    Deno.env.set("STRIPE_PRICE_STANDARD", "price_test_standard");
    Deno.env.set("STRIPE_PRODUCTS_ENTRY", "prod_test_entry");
    Deno.env.set("STRIPE_PRODUCTS_STANDARD", "prod_test_standard, prod_test_architect");
    eq(tierForPrice("price_test_entry"), "entry");
    eq(COACHING_PRICE_BY_TIER.entry, "price_test_entry");
    eq(COACHING_TIER_BY_PRICE["price_test_standard"], "standard");
    eq(tierForProduct("prod_test_architect"), "standard");
    eq(COACHING_TIER_BY_PRODUCT["prod_test_entry"], "entry");
    eq(Object.keys(COACHING_TIER_BY_PRODUCT).length, 3);
    eq(tierForProduct("prod_unknown"), null);
    eq(tierForProduct(null), null);
    eq(tierForPrice(null), null);
  } finally {
    keys.forEach((key, index) => saved[index] === undefined ? Deno.env.delete(key) : Deno.env.set(key, saved[index]!));
  }
});
