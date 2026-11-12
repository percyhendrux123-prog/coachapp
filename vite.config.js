import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build guard: refuse to ship a production bundle that points at a developer's machine.
//
// WHY THIS EXISTS. Vite inlines import.meta.env.* at build time, so any VITE_ variable in
// the .env file of whoever ran the build becomes a literal in the bundle. VITE_SITE_URL was
// http://localhost:5173 on the dev machine, so production shipped
// emailRedirectTo:"http://localhost:5173" and every client who asked /login for a sign-in
// link received one aimed at their own computer. Nothing errored: the request returned 200,
// the mail was delivered, the link led nowhere. The only signal was a client quietly
// concluding the app was broken.
//
// The offending read is gone — the redirect now resolves from window.location.origin at
// runtime — but that fix is one edit from being undone, and the same trap is open to
// VITE_SUPABASE_URL the moment anyone points it at a local Supabase. So this guard inspects
// what is actually emitted rather than trusting the source.
const LOOPBACK = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?`;

// CHECK A, on the emitted chunks: a loopback address used as a URL — something the app
// could actually send a user or a request to. Requires a scheme, which is what separates a
// destination from a comparison. supabase-js contains several bare "localhost" strings in
// hostname allow-lists and validity checks; those are values it compares against, never
// places it goes, so they are correctly not matched here.
const LOOPBACK_URL = new RegExp(String.raw`\bhttps?:\/\/${LOOPBACK}`, "gi");

// The one permitted destination, and why.
//
// @supabase/auth-js declares `export const GOTRUE_URL = 'http://localhost:9999'` as the
// default in its options object (auth-js/dist/module/lib/constants.js). It is dead on
// arrival: src/lib/supabase.js calls createClient(url, anonKey) and that real URL overrides
// the default before any request is made. The proof is empirical rather than argued — auth
// against the real project works in production today, which it could not if this constant
// were the URL in use.
//
// React Router 7 uses exact `http://localhost` as a URL-constructor base when no browser
// window exists. In the browser, createBrowserURLImpl replaces it with
// window.location.origin; in memory history it only parses pathname/search/hash. The app
// does not use Router data loaders or fetchers. Neither literal is a request destination.
// Both are matched exactly: any other localhost port or loopback host still fails.
const ALLOWED_VENDOR_URLS = new Set(["http://localhost", "http://localhost:9999"]);

// CHECK B, on our own source: no loopback token at all, in any form. Stricter than Check A
// on purpose. Vendor code gets the benefit of the doubt about its comparison strings;
// first-party code does not, because a loopback address in src/ is either a bug or about to
// become one. Config files are excluded — this file necessarily contains the patterns, and
// vite's own dev server is meant to bind locally.
const SOURCE_LOOPBACK = new RegExp(String.raw`\b${LOOPBACK}`, "i");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

function noDevAddresses() {
  return {
    name: "no-dev-addresses",
    apply: "build",
    enforce: "post",

    // Check B runs first so the message points at the source line, not a minified chunk.
    buildStart() {
      const offences = [];
      for (const file of walk("src")) {
        if (!/\.(jsx?|css)$/.test(file)) continue;
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          // Comments explain the bug and must be allowed to name the address.
          const code = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
          if (SOURCE_LOOPBACK.test(code)) offences.push(`  ${file}:${i + 1}  ${line.trim()}`);
        });
      }
      if (offences.length) {
        this.error(
          "\n\nBUILD BLOCKED — a loopback address appears in application source.\n\n" +
            offences.join("\n") +
            "\n\nAn address that differs between dev and production must be read at runtime\n" +
            "(window.location.origin), never written into source or an inlined env var.\n",
        );
      }
    },

    generateBundle(_options, bundle) {
      const offences = [];
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith(".map")) continue; // not served to clients
        const code = chunk.type === "chunk" ? chunk.code : String(chunk.source ?? "");
        const hits = [...new Set(code.match(LOOPBACK_URL) ?? [])]
          .filter((url) => !ALLOWED_VENDOR_URLS.has(url.toLowerCase()));
        if (hits.length) offences.push(`  ${fileName}: ${hits.join(", ")}`);
      }
      if (offences.length) {
        this.error(
          "\n\nBUILD BLOCKED — the production bundle points at a developer machine.\n\n" +
            offences.join("\n") +
            "\n\nThis is the bug that sent every client a magic link aimed at localhost:5173.\n" +
            "It does not throw at runtime; it quietly sends real users nowhere.\n\n" +
            "Fix the source. Do not add to the allow-list unless the address is provably\n" +
            "unreachable, and write down why.\n",
        );
      }
    },
  };
}

// Build stamp: make a deployed bundle able to say which commit produced it.
//
// WHY THIS EXISTS. On 2026-08-01 the repository gained its first remote, and answering the
// question "is production running code that exists in a commit?" took several hours of
// forensics — downloading the live bundle, extracting string literals, and grepping them
// against every blob in history — because the bundle carried no identity. It turned out two
// frontend files and seven edge functions had been running in production while existing in
// no commit, some for weeks. Nothing was broken; nothing reported anything; there was simply
// no way to ask.
//
// The failure was not that drift happened. Drift always happens. The failure was that
// detecting it required archaeology, so nobody did it, so it accumulated silently.
//
// This stamp makes the question a single HTTP request. It is written into index.html as a
// meta tag rather than into a JS chunk on purpose: a meta tag can be read by `curl` and a
// regex, with no bundle parsing, no minification to see through, and no dependency on the
// app booting. scripts/audit-drift.mjs reads exactly this.
//
// THE HONESTY RULE THIS FOLLOWS. If git cannot be reached, the stamp records "unknown"
// rather than omitting itself or guessing a value. An absent stamp and an unknown stamp are
// different facts — the first means the build predates this guard, the second means the
// build ran somewhere git could not answer. Both are reported; neither is invented. A stamp
// that quietly said "clean" when it did not know would be the same defect as the reconciler
// that returned {checked: 0} with HTTP 200.
function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function buildStamp() {
  return {
    name: "build-stamp",
    apply: "build",

    transformIndexHtml() {
      const commit = git(["rev-parse", "HEAD"]).slice(0, 40) || "unknown";
      // --porcelain lists tracked modifications and staged changes. Untracked files are
      // deliberately included (the `--untracked-files=all` default) because the whole class
      // of bug this guards against was untracked source that shipped to production.
      const status = commit === "unknown" ? null : git(["status", "--porcelain"]);
      const dirtyCount = status === null ? -1 : status.split("\n").filter(Boolean).length;
      const tree = dirtyCount < 0 ? "unknown" : dirtyCount === 0 ? "clean" : `dirty:${dirtyCount}`;

      return [
        { tag: "meta", attrs: { name: "x-build-commit", content: commit }, injectTo: "head" },
        { tag: "meta", attrs: { name: "x-build-tree", content: tree }, injectTo: "head" },
        { tag: "meta", attrs: { name: "x-build-time", content: new Date().toISOString() }, injectTo: "head" },
      ];
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), noDevAddresses(), buildStamp()],
  // Vite 8 did not replace an inline VITE_PREVIEW_ROUTES=1 consistently across
  // clean builds. Use an explicit one-off mode instead: ordinary `vite build`
  // always removes fixtures; `vite build --mode fixture-preview` includes them.
  define: {
    "globalThis.__COACHAPP_PREVIEW_ROUTES__": JSON.stringify(mode === "fixture-preview"),
  },
  // Verification must inspect the current build, not orphaned hashed chunks from
  // a previous mode. Vite 8 retained an old preview bundle in dist during this pass.
  build: { emptyOutDir: true },
  server: { port: 5173, host: true },
}));
