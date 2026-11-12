/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  // Footgun guard: without this, any future dark: utility would follow the OS setting
  // (the a2eb674 incident class) instead of the app's explicit toggle.
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Per-tenant theme neutrals (tenant_config.theme_key → src/lib/theme.js) as RGB
        // triplets so opacity modifiers work (border-ink/15 etc.). Unset variables fall
        // back to the original palette, so tenants on the default theme render as before.
        ink: "rgb(var(--ink-rgb, 10 10 10) / <alpha-value>)",
        paper: "rgb(var(--paper-rgb, 250 250 250) / <alpha-value>)",
        // Per-tenant brand accent. Falls back to ink when --brand-color is unset, so an
        // unbranded tenant's buttons follow the neutral palette — including its dark flip.
        brand: "var(--brand-color, rgb(var(--ink-rgb, 10 10 10)))",
        // Contrast-safe companions to `brand`, both computed in colorContrast.js from the
        // same tenant hex — never pick these by feel, always via that module.
        // Text sitting on a solid `bg-brand` fill (buttons, filled badges).
        "brand-text": "var(--brand-text, rgb(var(--paper-rgb, 250 250 250)))",
        // The accent used AS text color itself (labels, links) — a darkened/lightened,
        // hue-preserving variant of brand-color so it still reads as "the brand," just
        // legible. Falls back to `brand` itself when no tenant accent is set, matching
        // how text-brand behaved before this token existed.
        "brand-fg": "var(--brand-fg, var(--brand-color, rgb(var(--ink-rgb, 10 10 10))))",
        // Status colors routed through variables so dark mode can lighten them.
        danger: "rgb(var(--danger-rgb, 220 38 38) / <alpha-value>)", // red-600
        success: "rgb(var(--success-rgb, 21 128 61) / <alpha-value>)", // green-700
      },
      fontFamily: {
        // Body/UI stays Archivo. Display/kicker/section-title use its wide axis (see index.css).
        sans: ['"Archivo Variable"', "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        display: ["Archivo Variable", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
