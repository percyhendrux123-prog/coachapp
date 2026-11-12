// Picks readable text (near-black or near-white) for a given accent hex, so a
// coach's chosen brand color never has to double as an accessible foreground
// color too. Coaches pick any hue they like for --brand-color; this decides
// what sits on top of it once the app renders it as a button fill.
export function readableTextOn(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const luminance = relativeLuminance(rgb);
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  return contrastWithBlack >= contrastWithWhite ? "#0a0a0a" : "#fafafa";
}

// Darkens or lightens the accent hex (keeping its hue and saturation, so it
// still reads as "the brand color") until it clears WCAG AA (4.5:1) as small
// text against a given background. Used for text-only accent usage (labels,
// links, badges) — a use case readableTextOn doesn't cover, since that picks
// between only two fixed endpoints and would flatten every tenant's accent
// text to plain black or white instead of a readable shade of their own color.
export function accessibleForegroundOn(hex, backgroundHex, minRatio = 4.5) {
  const rgb = hexToRgb(hex);
  const bgRgb = hexToRgb(backgroundHex);
  if (!rgb || !bgRgb) return hex;
  const bgLuminance = relativeLuminance(bgRgb);
  if (contrastRatio(relativeLuminance(rgb), bgLuminance) >= minRatio) return hex;

  const { h, s, l } = rgbToHsl(rgb);
  // A light background needs a darkened accent; a dark background needs a
  // lightened one. Step in that direction until the ratio clears the bar.
  const direction = bgLuminance >= 0.5 ? -1 : 1;
  for (let step = 1; step <= 100; step++) {
    const nextL = clamp(l + direction * step * 0.01, 0, 1);
    const candidate = hslToRgb(h, s, nextL);
    if (contrastRatio(relativeLuminance(candidate), bgLuminance) >= minRatio) {
      return rgbToHex(candidate);
    }
    if (nextL <= 0 || nextL >= 1) break;
  }
  // Hue-preserving adjustment couldn't reach the target (rare, very desaturated
  // or mid-lightness colors) — fall back to the same two-endpoint pick used for
  // filled surfaces rather than ship an under-contrast color.
  return readableTextOn(hex) || hex;
}

function contrastRatio(luminanceA, luminanceB) {
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const int = parseInt(m[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function rgbToHex({ r, g, b }) {
  const toHex = (c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function relativeLuminance({ r, g, b }) {
  const [rl, gl, bl] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
  else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
  else h = 60 * ((rn - gn) / delta + 4);
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r1, g1, b1] = [0, 0, 0];
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
