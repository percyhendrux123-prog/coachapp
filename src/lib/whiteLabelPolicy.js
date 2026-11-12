import { isOwnerTenant } from "./tenantIdentity.js";

const BASE_DRAFT_STYLES = [
  { key: "balanced", label: "Balanced" },
  { key: "supportive", label: "Supportive" },
  { key: "direct", label: "Direct" },
];
const SIGNATURE_STYLE = { key: "signature", label: "Signature" };

export function neutralBrand() {
  const appName = import.meta.env?.VITE_APP_NAME?.trim() || "Coach App";
  return { appName, title: appName };
}

export function ownerRouteDecision({ user, tenant, role }) {
  if (!user || isOwnerTenant(tenant)) return { allow: true, redirectTo: null };
  return { allow: false, redirectTo: role === "coach" ? "/coach/brief" : "/client" };
}

export function challengeResultCopy(run) {
  if (run?.status === "rewarded") {
    return {
      rewarded: true,
      headline: "Perfect week.",
      detail: "You've earned a free month of Standard coaching.",
    };
  }
  return {
    rewarded: false,
    headline: "Perfect week recorded.",
    detail: "Your coach has your completed result.",
  };
}

export function availableDraftStyles(tenant) {
  return isOwnerTenant(tenant) ? [...BASE_DRAFT_STYLES, SIGNATURE_STYLE] : BASE_DRAFT_STYLES;
}

export function resolveDraftStyle(style, tenant) {
  return availableDraftStyles(tenant).some((option) => option.key === style) ? style : "balanced";
}

export function notificationAppName(appName) {
  const clean = String(appName || "").replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim();
  return clean || "Your coaching app";
}

export function acceptsConnectorToken(token) {
  return /^coach_mcp_[A-Za-z0-9]+$/.test(String(token || ""));
}
