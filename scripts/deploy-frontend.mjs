#!/usr/bin/env node
// Deployment guard: require committed source, compare deployed changes, and confirm explicitly.

import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
};

// --- guard: never deploy from a branch other than main --------------------
// Deploying from a feature branch is how production becomes a moving target
// nobody can reconstruct from main. Merge to main first, then deploy.
const branch = sh("git", ["branch", "--show-current"]);
if (branch !== "main") {
  console.error(
    `\nDEPLOY BLOCKED — current branch is '${branch}', not 'main'.\n` +
    "Deploying from a feature branch is how production drifts from the repository.\n" +
    "Merge this branch to main first, then deploy from main.\n",
  );
  process.exit(1);
}

// --- guard: never build from an uncommitted tree ----------------------------
// Same command the build-stamp plugin runs, so "would this deploy be flagged
// DRIFT?" is answered before the build instead of after it. Untracked files
// count on purpose (--untracked-files=all is git's default for --porcelain)
// -- an untracked file is still a file the build can read.
const dirty = sh("git", ["status", "--porcelain"]);
if (dirty) {
  console.error("\nDEPLOY BLOCKED — the working tree is not clean.\n");
  for (const line of dirty.split("\n")) console.error("  " + line);
  console.error(
    "\nBuilding from here would ship code (or config, or content) that exists\n" +
    "in no commit.\n" +
    "Commit or stash first, then deploy.\n",
  );
  process.exit(1);
}

// --- guard: production must come from the published main commit ------------
// A clean local main can still contain commits GitHub has never received. If
// that local-only commit is deployed first, production again becomes the only
// durable copy of running code. Refresh the remote reference and require exact
// equality before asking for the production confirmation.
try {
  execFileSync("git", ["fetch", "origin", "main", "--quiet"], { stdio: "ignore" });
} catch {
  console.error(
    "\nDEPLOY BLOCKED — could not refresh origin/main.\n" +
    "Production requires a verified published commit; retry when GitHub is reachable.\n",
  );
  process.exit(1);
}

const fullHead = sh("git", ["rev-parse", "HEAD"]);
const originMain = sh("git", ["rev-parse", "origin/main"]);
if (!fullHead || !originMain || fullHead !== originMain) {
  console.error(
    "\nDEPLOY BLOCKED — local main does not exactly match origin/main.\n" +
    `  local HEAD : ${fullHead ?? "unknown"}\n` +
    `  origin/main: ${originMain ?? "unknown"}\n\n` +
    "Push the reviewed main commit and verify the remote, then deploy.\n",
  );
  process.exit(1);
}

const head = fullHead.slice(0, 7);
console.log(`\nTree and origin/main are clean at ${head}. Building and deploying to production…\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`Type "deploy" to build and ship ${head} to production, anything else to abort: `);
rl.close();

if (answer.trim() !== "deploy") {
  console.log("Aborted. Nothing deployed.");
  process.exit(1);
}

// Always rebuild function bundles so environment changes are not cached.
const dep = spawnSync("netlify", ["deploy", "--prod", "--build", "--skip-functions-cache"], { stdio: "inherit" });
if (dep.status !== 0) process.exit(dep.status ?? 1);

console.log("\nDeployed. Verify the live application before handing it over.");
process.exit(0);
