// Display helpers for the client's read-only Profile tab.
//
// height_in / weight_lb are derived from the stored metric values, so they come back with
// conversion noise (5 ft 6 in saved by the coach reads back as 65.98 in, 160 lb as
// 160.06 lb). Show them the way a person would say them.

function finite(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// One decimal at most, and none when it is .0: 160.06 -> "160.1", 72.6 -> "72.6", 160 -> "160".
export function roundForDisplay(v) {
  const n = finite(v);
  if (n == null) return null;
  return String(Math.round(n * 10) / 10);
}

export function formatHeight({ imperial, height_in, height_cm }) {
  const inches = finite(height_in);
  if (imperial && inches != null) {
    const total = Math.round(inches);
    return `${Math.floor(total / 12)} ft ${total % 12} in`;
  }
  const cm = finite(height_cm);
  return cm != null ? `${Math.round(cm)} cm` : null;
}

export function formatWeight({ imperial, lb, kg }) {
  if (imperial && finite(lb) != null) return `${roundForDisplay(lb)} lb`;
  return finite(kg) != null ? `${roundForDisplay(kg)} kg` : null;
}

// Labels whose value must keep its case (an email address is not a title).
export const KEEP_CASE = new Set(["Email", "Name", "Coach"]);
