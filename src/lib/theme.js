// Tenant themes — presets keyed by tenant_config.theme_key, expressed as RGB triplets
// ("r g b") so tailwind's ink/paper colors can take opacity modifiers. Each preset carries
// a light and a dark palette. data-look drives optional shell styles (grid, terminal).
// This file is the single owner of --ink-rgb/--paper-rgb/data-theme/data-look.
export const DEFAULT_THEME_KEY = "liquid_glass";

export const THEMES = {
  // Original look. Default light clears CSS vars so tailwind fallbacks match pre-theme app.
  liquid_glass: {
    label: "Liquid glass",
    blurb: "Clean glass cards on paper — the default.",
    light: { ink: "10 10 10", paper: "250 250 250" },
    dark: { ink: "242 242 242", paper: "13 13 13" },
  },
  warm_studio: {
    label: "Warm studio",
    blurb: "Stone ink on warm cream paper.",
    light: { ink: "41 37 36", paper: "250 244 235" },
    dark: { ink: "250 245 238", paper: "28 22 18" },
  },
  cool_slate: {
    label: "Cool slate",
    blurb: "Navy ink on cool blue-grey paper.",
    light: { ink: "15 23 42", paper: "236 242 248" },
    dark: { ink: "226 232 240", paper: "8 15 28" },
  },
  mono_gym: {
    label: "Mono gym",
    blurb: "Hard black/white, high contrast.",
    light: { ink: "0 0 0", paper: "245 245 245" },
    dark: { ink: "250 250 250", paper: "8 8 8" },
  },
  // Optional “looks” — more than a palette shift.
  architecture_grid: {
    label: "Architecture grid",
    blurb: "Blueprint grid + structured lines.",
    light: { ink: "30 41 59", paper: "248 250 252" },
    dark: { ink: "226 232 240", paper: "15 23 42" },
  },
  terminal: {
    label: "Terminal",
    blurb: "Dark console; color means status.",
    // Terminal is intentionally dark-first; light mode still readable but dim.
    light: { ink: "22 101 52", paper: "240 253 244" },
    dark: { ink: "187 247 208", paper: "5 12 8" },
  },
};

export const THEME_STORAGE_KEY = "coachapp-theme";

// Explicit-only mode: "dark" iff the user chose it. No "system" option by design — the
// a2eb674 incident came from following the OS scheme, so the OS never drives this.
export function getMode() {
  try { return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light"; }
  catch { return "light"; }
}

// Remember the tenant's theme key so the mode toggle can re-apply without a refetch.
let currentThemeKey = DEFAULT_THEME_KEY;

// Apply a tenant's theme in the current (or given) mode. Single owner of the root
// variables — nothing else may set --ink-rgb/--paper-rgb/data-theme/data-look.
export function applyTheme(themeKey, mode = getMode()) {
  const root = document.documentElement;
  currentThemeKey = THEMES[themeKey] ? themeKey : DEFAULT_THEME_KEY;
  // Terminal look prefers dark paper even if the user hasn't flipped the global toggle —
  // but we never override their explicit light choice silently: only set data-look.
  root.dataset.theme = mode;
  root.dataset.look = currentThemeKey;

  if (mode === "light" && currentThemeKey === DEFAULT_THEME_KEY) {
    // Default light look = no variables, so tailwind fallbacks keep pre-dark rendering.
    root.style.removeProperty("--ink-rgb");
    root.style.removeProperty("--paper-rgb");
    return;
  }
  const p = THEMES[currentThemeKey][mode];
  root.style.setProperty("--ink-rgb", p.ink);
  root.style.setProperty("--paper-rgb", p.paper);
}

export function setMode(mode) {
  try { localStorage.setItem(THEME_STORAGE_KEY, mode); } catch { /* private browsing */ }
  applyTheme(currentThemeKey, mode);
}
