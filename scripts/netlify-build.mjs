#!/usr/bin/env node
// Netlify build entry (netlify.toml runs this). Plain-English failures on purpose: the person
// reading the deploy log may never have deployed anything before.
//
// What it does, in order:
//   1. Checks the two values the app cannot start without (VITE_SUPABASE_URL,
//      VITE_SUPABASE_ANON_KEY) and stops with a readable message if either is wrong.
//   2. Builds the frontend (vite build).
//   3. Writes the site's real address into dist/.well-known/* (AI connector discovery files).
//   4. On a production deploy, if SUPABASE_ACCESS_TOKEN is set: installs the server functions
//      in supabase/functions/ into the Supabase project, and sets the two function settings
//      that depend on the site address (APP_ORIGIN, ALLOWED_ORIGINS).
//
// Developers who deploy functions themselves set SKIP_FUNCTION_DEPLOY=1.
// Local rehearsal without touching any project: node scripts/netlify-build.mjs --dry-run

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUPABASE_CLI = "supabase@2.119.0";
const PLACEHOLDER_ORIGIN = "https://app.example.com";

export function projectRefFromUrl(url) {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(String(url || "").trim());
  return m ? m[1] : null;
}

// Returns a list of human-readable problems with the build settings (empty = fine).
export function checkSettings(env) {
  const problems = [];
  const url = String(env.VITE_SUPABASE_URL || "").trim();
  const key = String(env.VITE_SUPABASE_ANON_KEY || "").trim();
  if (!url) {
    problems.push("VITE_SUPABASE_URL is empty. Paste your Supabase Project URL (it looks like https://abcdefghijklmnopqrst.supabase.co).");
  } else if (!projectRefFromUrl(url)) {
    problems.push(`VITE_SUPABASE_URL does not look like a Supabase Project URL. Expected https://<20 letters>.supabase.co with nothing after it, got "${url.slice(0, 80)}".`);
  }
  if (!key) {
    problems.push("VITE_SUPABASE_ANON_KEY is empty. Paste the anon public key from Supabase (Project Settings > API Keys).");
  } else if (key.startsWith("sb_secret_") || /service_role/.test(decodeJwtRole(key) || "")) {
    problems.push("VITE_SUPABASE_ANON_KEY holds a SECRET key. Remove it now and paste the anon public key instead. Secret keys must never go in a VITE_ setting.");
  } else if (!key.startsWith("eyJ")) {
    problems.push("VITE_SUPABASE_ANON_KEY must be the key labelled anon public (it starts with eyJ). If Supabase shows a key starting with sb_publishable_, open the Legacy API Keys tab and copy the anon key there instead.");
  }
  return problems;
}

function decodeJwtRole(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).role || null;
  } catch {
    return null;
  }
}

// Function names, split by whether the Supabase gateway should check for a signed-in user
// before the function runs. A function's own config.toml with [verify_jwt] enabled = false
// means the function does its own authorization (webhooks, cron calls, public sign-up).
export function listFunctions(functionsDir = join(root, "supabase/functions")) {
  const verify = [];
  const noVerify = [];
  for (const name of readdirSync(functionsDir, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name.startsWith("_")) continue;
    const dir = join(functionsDir, name.name);
    if (!existsSync(join(dir, "index.ts"))) continue;
    const cfgPath = join(dir, "config.toml");
    const cfg = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";
    if (/\[verify_jwt\][\s\S]*?enabled\s*=\s*false\b/.test(cfg)) noVerify.push(name.name);
    else verify.push(name.name);
  }
  return { verify: verify.sort(), noVerify: noVerify.sort() };
}

export function rewriteWellKnown(distDir, siteUrl) {
  const origin = String(siteUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(origin)) return [];
  const changed = [];
  const dir = join(distDir, ".well-known");
  if (!existsSync(dir)) return changed;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const text = readFileSync(p, "utf8");
    if (text.includes(PLACEHOLDER_ORIGIN)) {
      writeFileSync(p, text.split(PLACEHOLDER_ORIGIN).join(origin));
      changed.push(f);
    }
  }
  return changed;
}

function fail(lines) {
  console.error("\n==================== SETUP PROBLEM ====================");
  for (const l of [].concat(lines)) console.error("- " + l);
  console.error("Fix it in Netlify: Site configuration > Environment variables, then Deploys > Trigger deploy.");
  console.error("Step-by-step help: SETUP.md in the project files.");
  console.error("=======================================================\n");
  process.exit(1);
}

function run(cmd, args, { dryRun, label }) {
  // Never print environment values; the command line itself carries no secrets.
  console.log(`$ ${cmd} ${args.join(" ")}`);
  if (dryRun) return;
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: process.env });
  if (r.status !== 0) fail(`${label} failed (exit ${r.status}). The lines just above say why.`);
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const env = process.env;
  const onNetlify = env.NETLIFY === "true";
  const production = env.CONTEXT === "production";

  const problems = checkSettings(env);
  if (problems.length) fail(problems);
  const ref = projectRefFromUrl(env.VITE_SUPABASE_URL);
  console.log(`Settings look right. Supabase project: ${ref}`);

  // 1. Frontend.
  run("npx", ["vite", "build"], { dryRun: false, label: "Building the app" });

  // 2. Site address into the AI-connector discovery files.
  const siteUrl = env.URL || "";
  const changed = rewriteWellKnown(join(root, "dist"), siteUrl);
  if (changed.length) console.log(`Wrote ${siteUrl} into dist/.well-known/ (${changed.join(", ")}).`);

  // 3. Server functions.
  if (env.SKIP_FUNCTION_DEPLOY === "1") {
    console.log("SKIP_FUNCTION_DEPLOY=1: not installing server functions.");
    return;
  }
  if (!onNetlify && !dryRun) {
    console.log("Local build: server functions are only installed by a Netlify production deploy (or rehearse with --dry-run).");
    return;
  }
  if (onNetlify && !production) {
    console.log(`Deploy context "${env.CONTEXT}": server functions are only installed on production deploys.`);
    return;
  }
  if (!env.SUPABASE_ACCESS_TOKEN && !dryRun) {
    fail("SUPABASE_ACCESS_TOKEN is empty. The app's server functions (client invites, sign-in codes, check-ins) cannot be installed without it. Create one at supabase.com/dashboard/account/tokens and paste it.");
  }

  const { verify, noVerify } = listFunctions();
  console.log(`Installing ${verify.length + noVerify.length} server functions into Supabase project ${ref}.`);
  const npx = ["--yes", SUPABASE_CLI, "functions", "deploy"];
  if (verify.length) {
    run("npx", [...npx, ...verify, "--project-ref", ref, "--use-api"], { dryRun, label: "Installing server functions" });
  }
  if (noVerify.length) {
    run("npx", [...npx, ...noVerify, "--project-ref", ref, "--use-api", "--no-verify-jwt"], { dryRun, label: "Installing server functions" });
  }

  if (/^https:\/\//.test(siteUrl)) {
    const host = new URL(siteUrl).hostname;
    run("npx", ["--yes", SUPABASE_CLI, "secrets", "set", `APP_ORIGIN=${siteUrl}`, `ALLOWED_ORIGINS=${host}`, "--project-ref", ref],
      { dryRun, label: "Saving the site address in Supabase" });
  }
  console.log(dryRun ? "Dry run: nothing was installed." : "Server functions installed.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
