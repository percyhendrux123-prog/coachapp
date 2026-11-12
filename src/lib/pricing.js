// Checkout identifiers are deployment configuration, never bundled account defaults.
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
export const COACHING_TIERS = [
  { key: "entry", name: "Entry", priceId: env.VITE_STRIPE_PRICE_ENTRY || "", amount: null, interval: "month", label: "Your plan" },
  { key: "standard", name: "Coaching", priceId: env.VITE_STRIPE_PRICE_STANDARD || "", amount: null, interval: "month", label: "Your plan" },
];
export const tierByKey = (key) => COACHING_TIERS.find((t) => t.key === key) ?? null;
