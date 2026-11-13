// One-tap "Connect to Claude" link. Anthropic documents a prefill URL for connectors that
// are not in their directory: it opens claude.ai's "Add custom connector" dialog with the
// name and server URL already filled in; the person reviews and presses Continue, then our
// own sign-in page takes over (email → code → pick read / full). Works on Free, Pro
// and Max. Source (verified 2026-09-04):
// https://claude.com/docs/connectors/building/directory-vs-custom#custom-connectors
//
// Pure module on purpose — no supabase import — so it runs under plain `node --test`.

export const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";

export function claudeInstallUrl({ name, endpoint }) {
  const n = String(name || "").trim();
  const e = String(endpoint || "").trim();
  if (!n || !e) return null; // never hand out a half-built link
  const params = new URLSearchParams({
    modal: "add-custom-connector",
    connectorName: n,
    connectorUrl: e,
  });
  return `${CLAUDE_CONNECTORS_URL}?${params.toString()}`;
}
