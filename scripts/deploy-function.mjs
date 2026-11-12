#!/usr/bin/env node
// Deployment guard: require committed source, compare deployed changes, and confirm explicitly.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
if (!PROJECT_REF) {
  console.error("SUPABASE_PROJECT_REF must be set before deploying a function.");
  process.exit(2);
}
const slug = process.argv[2];

if (!slug) {
  console.error("usage: npm run deploy:fn <function-name>");
  process.exit(2);
}

const dir = `supabase/functions/${slug}`;
if (!existsSync(dir)) {
  console.error(`No such function in this repo: ${dir}`);
  console.error("If it is deployed but has no source here, that is itself the problem —");
  console.error("recover the source before deploying anything.");
  process.exit(2);
}

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch { return null; }
};

// Which _shared/*.ts files does this function's own source actually import?
// Bundled shared code is invisible to a check that only looks at `dir` — it can
// carry uncommitted or production-diverged changes onto a deploy with no warning.
function sharedImportsOf(functionDir) {
  const found = new Set();
  const re = /from\s+["']\.\.\/_shared\/([A-Za-z0-9_-]+\.ts)["']/g;
  for (const f of readdirSync(functionDir).filter((f) => f.endsWith(".ts"))) {
    const content = readFileSync(join(functionDir, f), "utf8");
    let m;
    while ((m = re.exec(content))) found.add(m[1]);
  }
  return [...found].sort();
}
const sharedFiles = sharedImportsOf(dir);
const sharedPaths = sharedFiles.map((f) => `supabase/functions/_shared/${f}`);

// --- guard: never deploy from a branch other than main --------------------
// Deploying from a feature branch is how production becomes a moving target
// nobody can reconstruct from main. Merge to main first, then deploy.
const deployBranch = sh("git", ["branch", "--show-current"]);
if (deployBranch !== "main") {
  console.error(
    `\nDEPLOY BLOCKED — current branch is '${deployBranch}', not 'main'.\n` +
    "Deploying from a feature branch is how production drifts from the repository.\n" +
    "Merge this branch to main first, then deploy from main.\n",
  );
  process.exit(1);
}

// --- guard 1: never deploy code that is not committed -----------------------
const dirty = sh("git", ["status", "--porcelain", "--", dir, ...sharedPaths]);
if (dirty) {
  console.error(`\nDEPLOY BLOCKED — ${slug} has changes that are not committed.\n`);
  for (const line of dirty.split("\n")) console.error("  " + line);
  if (sharedPaths.some((p) => dirty.includes(p.split("/").pop()))) {
    console.error(
      `  (${slug} imports ${sharedFiles.join(", ")} from _shared/ — uncommitted changes\n` +
      `  there ride along on this deploy just as much as changes to ${slug}'s own files.)\n`,
    );
  }
  console.error(
    "\nDeploying this would put code into production that exists in no commit.\n" +
    "Commit first, then deploy.\n",
  );
  process.exit(1);
}

// --- guard 2: show what deploying would change ------------------------------
console.log(`\nFetching what is currently deployed as "${slug}"…`);
const tmp = mkdtempSync(join(tmpdir(), "predeploy-"));
mkdirSync(join(tmp, "supabase", "functions"), { recursive: true });
writeFileSync(join(tmp, "supabase", "config.toml"), `project_id = "${PROJECT_REF}"\n`);

const got = sh("supabase", ["functions", "download", slug, "--project-ref", PROJECT_REF, "--workdir", tmp]);
const liveDir = join(tmp, "supabase", "functions", slug);

let changes = 0;
let couldNotCompare = false;

if (got === null || !existsSync(liveDir)) {
  couldNotCompare = true;
  console.log(
    "\n  Could not download the deployed version.\n" +
    "  It may not be deployed yet — or the check may simply have failed.\n" +
    "  Those are different, and this script will not guess which.\n",
  );
} else {
  const liveFiles = readdirSync(liveDir).filter((f) => f.endsWith(".ts"));

  // The download also bundles whatever _shared/*.ts this deploy currently
  // freezes — compare those too, against the CURRENT repo _shared file, not
  // just the function's own files. This is how a stale/diverged shared file
  // (e.g. a function still bundling an old _shared/challenge.ts) gets caught
  // instead of silently riding along on the next deploy.
  const liveSharedDir = join(tmp, "supabase", "functions", "_shared");
  const liveSharedFiles = existsSync(liveSharedDir)
    ? readdirSync(liveSharedDir).filter((f) => f.endsWith(".ts"))
    : [];

  const compareSets = [
    { label: (f) => f, liveBase: liveDir, localBase: dir, files: liveFiles },
    { label: (f) => `_shared/${f}`, liveBase: liveSharedDir, localBase: "supabase/functions/_shared", files: liveSharedFiles },
  ];

  console.log("");
  for (const { label, liveBase, localBase, files } of compareSets) {
    for (const file of files) {
      const live = join(liveBase, file);
      const local = join(localBase, file);
      const name = label(file);
      if (!existsSync(local)) {
        changes++;
        console.log(`  ${name}: deployed, but ABSENT from this repo — deploying would REMOVE it.`);
        continue;
      }
      const r = spawnSync("diff", ["-u", live, local], { encoding: "utf8" });
      if (r.status === 0) { console.log(`  ${name}: identical`); continue; }
      changes++;
      const lines = r.stdout.split("\n");
      const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
      const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
      console.log(`  ${name}: ${added.length} line(s) added, ${removed.length} line(s) REMOVED by this deploy`);
      if (removed.length) {
        console.log("\n    Lines that exist in production and would be DELETED:");
        for (const l of removed.slice(0, 25)) console.log("      " + l);
        if (removed.length > 25) console.log(`      … and ${removed.length - 25} more`);
        console.log("");
      }
    }
  }
  // Local-only files are additions, which are safe, but worth naming.
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !liveFiles.includes(f))) {
    changes++;
    console.log(`  ${file}: new file, would be added`);
  }
  for (const file of sharedFiles.filter((f) => !liveSharedFiles.includes(f))) {
    changes++;
    console.log(`  _shared/${file}: imported locally but not part of the current deploy's bundle — new file, would be added`);
  }
}

// A config.toml verify_jwt setting is gateway-level metadata, not part of the
// downloadable function bundle -- `supabase functions download` cannot see it,
// so an identical source diff does NOT mean the live gateway setting matches
// what is committed. If a local config requests verify_jwt=false, always proceed to a real deploy -- redundantly
// reapplying an already-correct flag is harmless; silently skipping a needed
// one is not.
const configCallsForNoVerifyJwt = existsSync(join(dir, "config.toml"))
  && /\[verify_jwt\][\s\S]*?enabled\s*=\s*false\b/.test(readFileSync(join(dir, "config.toml"), "utf8"));

if (!changes && !couldNotCompare && !configCallsForNoVerifyJwt) {
  console.log("\nDeployed version is already identical to the committed source. Nothing to do.");
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
if (!changes && !couldNotCompare && configCallsForNoVerifyJwt) {
  console.log(
    "\nSource is identical, but this function's config.toml calls for verify_jwt=false --\n" +
    "that setting can't be verified from the downloaded source, so proceeding to deploy\n" +
    "anyway to make sure it's actually applied.\n",
  );
}

console.log(
  "\nRead the removals above before continuing. A line that exists only in\n" +
  "production is a capability nobody wrote down — deleting it is silent.\n",
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`Type the function name ("${slug}") to deploy, anything else to abort: `);
rl.close();
rmSync(tmp, { recursive: true, force: true });

if (answer.trim() !== slug) {
  console.log("Aborted. Nothing deployed.");
  process.exit(1);
}

console.log(`\nDeploying ${slug}…`);
const deployArgs = ["functions", "deploy", slug, "--project-ref", PROJECT_REF];
const functionConfig = join(dir, "config.toml");
if (existsSync(functionConfig)) {
  const config = readFileSync(functionConfig, "utf8");
  if (/\[verify_jwt\][\s\S]*?enabled\s*=\s*false\b/.test(config)) {
    deployArgs.push("--no-verify-jwt");
    console.log("  Public webhook config detected; preserving verify_jwt=false.");
  }
}
const dep = spawnSync("supabase", deployArgs, { stdio: "inherit" });
process.exit(dep.status ?? 1);
