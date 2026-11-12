export function notificationAppName(appName: unknown, fallback = "Your coaching app"): string {
  const clean = String(appName || "")
    .replace(/[\r\n<>]/g, " ")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean || fallback;
}

// Coach-side push (notify-coach). The subject is the client, so the title carries their
// name (sanitised the same way as an app name) and the body carries the least that lets
// the coach decide whether to open it now. `url` is what the service worker opens.
export function coachPushTemplate(kind: "message" | "checkin", clientName: unknown, messageBody?: unknown) {
  const who = notificationAppName(clientName, "A client");
  if (kind === "checkin") {
    return { title: `${who} checked in`, body: "Tap to open it.", url: "/coach" };
  }
  const snippet = String(messageBody ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
  return { title: `${who} messaged you`, body: snippet || "Tap to open the inbox.", url: "/coach/inbox" };
}

export function pushTemplate(template: string, appName: unknown) {
  const title = notificationAppName(appName, "Your coach");
  const bodies: Record<string, string> = {
    message: "You've got a message. Open your hub.",
    checkin_due: "Your check-in is due. Open your hub.",
  };
  return { title, body: bodies[template] || bodies.message };
}
