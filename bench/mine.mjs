#!/usr/bin/env node
/**
 * Mine a candidate benchmark instance from one fix commit.
 *
 *   node bench/mine.mjs --repo DIR --fix COMMIT [--out FILE] [--max-files N]
 *
 * A fix commit that changed both tests and source is a FAIL_TO_PASS candidate:
 * the test it added fails on the parent and passes at the fix. The instance uses
 * `testPatch` (the materialiser copies the changed tests into the buggy
 * checkout) and `mode: worktree` (the repro needs the repo's own toolchain).
 *
 * This emits a *candidate*, not a verified instance: run
 * `bench/materialize.mjs --instance FILE --yes` and keep it only if the oracle
 * fails at the parent and passes at the fix. Gold hunks are the old-side ranges
 * of the source files the fix touched.
 *
 * It is deliberately dumb: no ranking, no filtering beyond "changed tests and
 * changed source". A feature commit also qualifies — the parent's missing
 * behaviour is a silent bug for benchmarking purposes — so review the gold hunks
 * and the failing output before adding the instance to `corpus/`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const USAGE = `usage: mine.mjs --repo DIR --fix COMMIT [--out FILE] [--max-files N]
  --repo DIR      the git repository to mine (required)
  --fix COMMIT    the fix commit (required)
  --out FILE      write the candidate instance JSON here (default: stdout)
  --max-files N   include at most N source files' gold hunks (default 2)`;

const TEST_FILE = /(^|\/)(?:test_.*\.py|.*_test\.py|.*\.(?:test|spec)\.[cm]?[jt]sx?)$/i;

function git(repo, args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** Old-side hunk ranges from `git show -U0`, as [{file, lines:[[a,b],…]}]. */
export function parseOldHunks(diff) {
  const out = [];
  let cur = null;
  for (const line of String(diff ?? "").split(/\r?\n/)) {
    const f = /^\+\+\+ b\/(.*)$/.exec(line);
    if (f) {
      cur = { file: f[1].trim(), lines: [] };
      out.push(cur);
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (h && cur) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      cur.lines.push([start, count === 0 ? start : start + count - 1]);
    }
  }
  return out.filter((t) => !t.file.startsWith("a/dev/null") && t.lines.length);
}

/** The runner the repo's tests need, from the files and its package.json. */
export function runnerFor(repo, tests) {
  if (tests.some((f) => f.endsWith(".py"))) return "pytest";
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  } catch {
    // no package.json: fall through to the runnerless node --test
  }
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  if (deps?.vitest) return "vitest";
  if (deps?.jest) return "jest";
  return "node";
}

/** The test command for the changed tests and the runner they need. */
export function testCommand(tests, runner = "node") {
  if (runner === "pytest") return `python -m pytest -q ${tests.join(" ")}`;
  if (runner === "vitest") return `npx vitest run ${tests.join(" ")}`;
  if (runner === "jest") return `npx jest ${tests.join(" ")}`;
  return `node --test ${tests.join(" ")}`;
}

/** Build a candidate instance object for one fix commit. */
export function mine(repo, fix, { maxFiles = 2 } = {}) {
  const parent = git(repo, ["rev-parse", `${fix}^`]);
  if (parent.code !== 0) throw new Error(`${fix} has no parent — nothing to diff`);
  const files = git(repo, ["show", "--name-only", "--format=", fix])
    .out.split(/\r?\n/)
    .filter(Boolean);
  const tests = files.filter((f) => TEST_FILE.test(f));
  const source = files.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(f) && !TEST_FILE.test(f));
  if (!tests.length) throw new Error(`${fix} changed no test files — not a FAIL_TO_PASS candidate`);
  if (!source.length) throw new Error(`${fix} changed no source files`);

  const goldHunks = [];
  for (const file of source.slice(0, maxFiles)) {
    const diff = git(repo, ["show", "--format=", "-U0", fix, "--", file]).out;
    for (const [start, end] of parseOldHunks(diff).flatMap((t) => t.lines)) {
      // A hunk at line 0 is a file the fix added: it has no buggy-side lines,
      // so it cannot be the location of a cause in the parent checkout.
      if (start >= 1 && end >= start) goldHunks.push({ file, start, end });
    }
  }
  if (!goldHunks.length) throw new Error(`${fix} touched no source lines with hunks`);

  const command = testCommand(tests, runnerFor(repo, tests));
  return {
    id: `${basename(resolve(repo))}-${fix.slice(0, 8)}`,
    source: "local",
    repo: resolve(repo).replaceAll("\\", "/"),
    commit: parent.out,
    fixCommit: git(repo, ["rev-parse", fix]).out,
    mode: "worktree",
    testPatch: true,
    repro: { command },
    oracle: { command },
    expect: { goldHunks },
    notes: `Mined from ${fix} (${git(repo, ["show", "-s", "--format=%s", fix]).out}). Unverified: materialise it before adding.`,
  };
}

function parseArgs(argv) {
  const opts = { maxFiles: 2 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      return null;
    }
    const value = argv[++i];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error(`unrecognised argument: ${flag}\n\n${USAGE}`);
    if (flag === "--repo") opts.repo = value;
    else if (flag === "--fix") opts.fix = value;
    else if (flag === "--out") opts.out = value;
    else if (flag === "--max-files") opts.maxFiles = Number(value);
    else throw new Error(`unrecognised flag: ${flag}\n\n${USAGE}`);
  }
  if (!opts.repo || !opts.fix) throw new Error(`--repo and --fix are required\n\n${USAGE}`);
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;
  const instance = mine(opts.repo, opts.fix, { maxFiles: opts.maxFiles });
  const body = JSON.stringify(instance, null, 2) + "\n";
  if (opts.out) writeFileSync(opts.out, body, "utf8");
  else console.log(body);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (err) {
    console.error(`[mine] ${err.message}`);
    process.exitCode = 1;
  }
}
