// Hostname allowlist shared by checkout and provisioning redirect guards.
export function allowedOrigins(): string[] {
  const configured = Deno.env.get("ALLOWED_ORIGINS")?.trim();
  if (configured) return [...new Set(configured.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean))];
  const origin = Deno.env.get("APP_ORIGIN") || "http://localhost:5173";
  try { return [...new Set([new URL(origin).hostname, "localhost"])]; }
  catch { return ["localhost"]; }
}
