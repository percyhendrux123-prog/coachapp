import React from "react";

// The app had no error boundary: any render-time throw emptied the React tree, and on a
// device with dark mode saved the pre-paint guard left a solid near-black page with nothing
// to read. Render a readable error surface even when a saved dark theme is active.
//
// Two behaviours:
//  1. A dead code chunk (the page shell was cached across a deploy, so a lazy route asks
//     for a hashed file that no longer exists) reloads the page ONCE. Stale shell → fresh
//     shell. A sessionStorage flag stops a reload loop if the reload does not fix it.
//  2. Anything else renders the error text on paper with a reload button, so a black
//     screen becomes a message a human can send to support.
const RELOAD_FLAG = "coachapp-chunk-reload";
const CHUNK_RE = /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|error loading dynamically imported module/i;

export default class RootErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) {
    const msg = String(error?.message || error || "");
    if (CHUNK_RE.test(msg)) {
      let already = false;
      try { already = sessionStorage.getItem(RELOAD_FLAG) === "1"; if (!already) sessionStorage.setItem(RELOAD_FLAG, "1"); } catch { /* private mode */ }
      if (!already) { window.location.reload(); return; }
    }
    console.error("RootErrorBoundary:", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const msg = String(this.state.error?.message || this.state.error || "Unknown error");
    return (
      <main className="grid min-h-screen place-items-center bg-paper px-5 py-12 text-ink">
        <section className="w-full max-w-sm rounded-2xl border border-ink/10 p-6">
          <span className="kicker">Coaching app</span>
          <h1 className="display mt-2 text-2xl">This page hit an error.</h1>
          <p className="mt-3 text-sm opacity-70">Reload usually fixes it. If it keeps happening, send this line to support:</p>
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ink/5 p-3 text-xs">{msg}</pre>
          <button type="button" onClick={() => { try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* ignore */ } window.location.reload(); }}
            className="btn-primary mt-5 min-h-[44px] px-4">Reload</button>
        </section>
      </main>
    );
  }
}
