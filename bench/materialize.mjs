#!/usr/bin/env node
/**
 * Corpus materialisation (design §4, Phase 1).
 *
 * An instance spec names a buggy checkout, the command that fails there, and the
 * gold hunks that a correct cause must intersect. This module turns that spec
 * into a runnable directory and *verifies the premise*: the gold-hunk files
 * exist, the repro actually fails, and the commit is the one named. A corpus you
 * cannot materialise is a corpus you cannot measure, and §11 of architecture.md
 * says as much — so the materialiser is the first half of the benchmark.
 *
 *   node bench/materialize.mjs --instance FILE [--out DIR] [--keep] [--yes]
 *   node bench/materialize.mjs --instances DIR --out DIR --yes
 *
 * Only the `local` source exists today: `repo` is a path to a git repository on
 * this machine (BugsInPy/SWE-bench need Docker or the network and are added with
 * their own materialiser — see docs/implementation.md). The repro command is a
 * model-authored string, so nothing executes without `--yes`.
 *
 * Exit 0 = every instance materialised; 1 = at least one refused; 3 = dry run.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childEnv } from "../skills/ducktective/scripts/lib/exec.mjs";
import { validateInstance } from "./sources.mjs";

/** Gitignored scratch for ledgers when no --out is given. */
const WORK = join(dirname(fileURLToPath(import.meta.url)), "..", "evals", ".work");

export const USAGE = `usage: materialize.mjs (--instance FILE | --instances DIR) [options]
  --instance FILE  one instance spec (JSON)
  --instances DIR  every *.json in DIR (one instance, or an array of them)
  --out DIR        where to materialise (default: a temp directory)
  --keep           keep the temp output directory (--out is always kept)
  --timeout MS     kill the repro after this long (default: 120000)
  --yes            actually clone, check out and run the repro`;

/** Read every `*.json` in `dir`; each file is one instance or an array. */
export function loadInstances(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
    out.push(...(Array.isArray(raw) ? raw : [raw]));
  }
  return out;
}

/** Every validation problem across a corpus, as `id: problem`. */
export function checkInstances(instances) {
  const problems = [];
  for (const inst of instances)
    for (const p of validateInstance(inst)) problems.push(`${inst?.id ?? "?"}: ${p}`);
  return problems;
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function runCommand(command, cwd, timeout) {
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    windowsHide: true,
    env: childEnv(),
    timeout,
  });
  return { code: r.error ? null : r.status, error: r.error?.message ?? null };
}

function lineCount(file) {
  return readFileSync(file, "utf8").split(/\r?\n/).length;
}

/**
 * Clone `instance.repo` at its commit into `dest`, then verify the premise:
 * the gold-hunk files exist and cover real lines, and the repro fails.
 *
 * @returns {{id: string, ok: boolean, problems: string[], dir?: string, head?: string, repro_exit?: number|null}}
 */
export function materialize(instance, { dest, timeout = 120_000 } = {}) {
  const id = instance?.id ?? "?";
  const problems = validateInstance(instance);
  if (problems.length) return { id, ok: false, problems };
  if (!dest) return { id, ok: false, problems: ["no destination directory given"] };

  const repo = resolve(instance.repo);
  if (!existsSync(join(repo, ".git")))
    return { id, ok: false, problems: [`not a git repository: ${repo}`] };

  // `clone` isolates the checkout but loses installed dependencies; `worktree`
  // keeps them (the checkout sits inside the repo, so `node_modules` resolves)
  // and is the mode for a repo whose repro needs its own toolchain.
  const mode = instance.mode === "worktree" ? "worktree" : "clone";
  if (mode === "worktree") {
    const added = addWorktree(repo, instance.commit, dest);
    if (!added.ok) return { id, ok: false, problems: [added.problem] };
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    const clone = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", "--", repo, dest], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (clone.status !== 0)
      return {
        id,
        ok: false,
        problems: [`clone failed: ${(clone.stderr || "").trim().slice(0, 200)}`],
      };
    if (instance.commit) {
      const co = git(["checkout", "--quiet", "--detach", instance.commit], dest);
      if (co.code !== 0)
        return {
          id,
          ok: false,
          problems: [`checkout ${instance.commit} failed: ${co.err.slice(0, 200)}`],
          dir: dest,
        };
    }
  }
  const head = git(["rev-parse", "HEAD"], dest).out;

  // Instance assets (an oracle script, a data fixture) are copied into the
  // checkout so the oracle can name them by basename.
  for (const asset of instance.assets ?? []) {
    const from = resolve(asset);
    if (!existsSync(from))
      return { id, ok: false, problems: [`asset not found: ${asset}`], dir: dest, head };
    cpSync(from, join(dest, basename(from)), { recursive: true });
  }

  // `testPatch` copies the tests the fix commit changed into the buggy
  // checkout, so a repo-authored test becomes a FAIL_TO_PASS oracle.
  let testPatchFiles = [];
  if (instance.testPatch) {
    testPatchFiles = copyTestPatch(instance, dest, repo);
    if (!testPatchFiles.length)
      return {
        id,
        ok: false,
        problems: ["testPatch found no changed test files between commit and fixCommit"],
        dir: dest,
        head,
      };
  }

  const hunkProblems = [];
  for (const hunk of instance.expect.goldHunks) {
    const file = join(dest, hunk.file);
    if (!existsSync(file)) {
      hunkProblems.push(`gold hunk file is missing: ${hunk.file}`);
      continue;
    }
    const lines = lineCount(file);
    if (hunk.end > lines)
      hunkProblems.push(
        `gold hunk ${hunk.file}:${hunk.start}-${hunk.end} is past the file (${lines} lines)`,
      );
  }
  if (hunkProblems.length) return { id, ok: false, problems: hunkProblems, dir: dest, head };

  const reproCommand = instance.repro?.command ?? instance.oracle?.command;
  const repro = runCommand(reproCommand, dest, timeout);
  if (repro.code === 0)
    return {
      id,
      ok: false,
      problems: ["the repro passed at this commit — the instance is not buggy"],
      dir: dest,
      head,
      repro_exit: 0,
    };
  if (repro.code === null)
    return {
      id,
      ok: false,
      problems: [`the repro could not be run: ${repro.error ?? "unknown"}`],
      dir: dest,
      head,
      repro_exit: null,
    };

  // An instance-supplied oracle must fail at the buggy commit, and — when a
  // fix commit is named — pass there. That is the receipt that the bug is real
  // and the oracle is a fix oracle, not an always-fail command.
  let oracleAtCommit = null;
  let oracleAtFix = null;
  let oracleVerified = false;
  if (instance.oracle?.command) {
    oracleAtCommit =
      instance.oracle.command === reproCommand
        ? repro.code
        : runCommand(instance.oracle.command, dest, timeout).code;
    if (oracleAtCommit === 0)
      return {
        id,
        ok: false,
        problems: ["the oracle passes at the buggy commit — it does not demonstrate the bug"],
        dir: dest,
        head,
        repro_exit: repro.code,
        oracle_at_commit: oracleAtCommit,
      };
    if (instance.fixCommit) {
      // Copied test files exist (committed) at the fix revision, so an untracked
      // copy would obstruct the checkout; remove, check out, then re-copy for
      // the arms.
      for (const file of testPatchFiles) rmSync(join(dest, file), { force: true });
      const co = git(["checkout", "--quiet", "--detach", instance.fixCommit], dest);
      if (co.code !== 0)
        return {
          id,
          ok: false,
          problems: [`checkout fixCommit ${instance.fixCommit} failed: ${co.err.slice(0, 200)}`],
          dir: dest,
          head,
        };
      oracleAtFix = runCommand(instance.oracle.command, dest, timeout).code;
      // The arms run against the buggy revision, so restore it.
      git(["checkout", "--quiet", "--detach", head], dest);
      if (testPatchFiles.length) copyTestPatch(instance, dest, repo);
      if (oracleAtFix !== 0)
        return {
          id,
          ok: false,
          problems: [`the oracle still fails at the fix commit (exit ${oracleAtFix})`],
          dir: dest,
          head,
          repro_exit: repro.code,
          oracle_at_commit: oracleAtCommit,
          oracle_at_fix: oracleAtFix,
        };
      oracleVerified = true;
    }
  }

  return {
    id,
    ok: true,
    problems: [],
    dir: dest,
    head,
    repro_exit: repro.code,
    ...(instance.oracle?.command
      ? { oracle_at_commit: oracleAtCommit, oracle_at_fix: oracleAtFix }
      : {}),
    ...(testPatchFiles.length ? { test_patch: testPatchFiles } : {}),
    oracle_verified: oracleVerified,
  };
}

/** Test files changed in a commit, by the shape of their name. */
const TEST_FILE = /(^|\/)(?:test_.*\.py|.*_test\.py|.*\.(?:test|spec)\.[cm]?[jt]sx?)$/i;

/** Copy the test files a fix commit changed into the buggy checkout. */
function copyTestPatch(instance, dest, repo) {
  const diff = spawnSync("git", ["diff", "--name-only", instance.commit, instance.fixCommit], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  });
  if (diff.status !== 0) return [];
  const files = (diff.stdout ?? "").split(/\r?\n/).filter((f) => f && TEST_FILE.test(f));
  const copied = [];
  for (const file of files) {
    const blob = spawnSync("git", ["show", `${instance.fixCommit}:${file}`], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
    });
    if (blob.status !== 0) continue;
    const to = join(dest, file);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, blob.stdout ?? "");
    copied.push(file);
  }
  return copied;
}

/** Create a detached worktree of `repo` at `commit` (or HEAD) at `dest`. Never throws. */
export function addWorktree(repo, commit, dest) {
  try {
    // A crashed run can leave a stale registration or directory behind; clear it
    // first so a re-run never fails on "already registered worktree". Every step
    // is tolerant: on Windows an editor's watcher can hold a handle inside the
    // old worktree, and a half-clear must still end in a clear problem, not a crash.
    spawnSync("git", ["worktree", "remove", "--force", "--quiet", dest], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
    });
    try {
      rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* locked; the add below will say if the path is still unusable */
    }
    spawnSync("git", ["worktree", "prune"], { cwd: repo, encoding: "utf8", windowsHide: true });
    mkdirSync(dirname(dest), { recursive: true });
    const add = spawnSync(
      "git",
      ["worktree", "add", "--detach", "--quiet", dest, commit ?? "HEAD"],
      {
        cwd: repo,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    return add.status === 0
      ? { ok: true }
      : {
          ok: false,
          problem: `git worktree add failed: ${(add.stderr || "").trim().slice(0, 200)}`,
        };
  } catch (err) {
    return {
      ok: false,
      problem: `git worktree add failed: ${String(err?.message ?? err).slice(0, 200)}`,
    };
  }
}

/** Remove a worktree `addWorktree` made, tolerating locked files on Windows. */
export function removeWorktree(repo, dest) {
  const rm = () => {
    try {
      // Windows can hold a handle to a just-exited process's cwd for a moment.
      rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* locked; the second attempt after unregistering often succeeds */
    }
  };
  spawnSync("git", ["worktree", "remove", "--force", "--quiet", dest], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  });
  rm();
  spawnSync("git", ["worktree", "prune"], { cwd: repo, encoding: "utf8", windowsHide: true });
  spawnSync("git", ["worktree", "prune", "--expire", "now"], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  });
  rm();
}

function parseArgs(argv) {
  const opts = { timeout: 120_000, yes: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      return null;
    }
    if (flag === "--yes" || flag === "--keep") {
      opts[flag.slice(2)] = true;
      continue;
    }
    const value = argv[++i];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error(`unrecognised argument: ${flag}\n\n${USAGE}`);
    if (flag === "--instance") opts.instance = resolve(value);
    else if (flag === "--instances") opts.instances = resolve(value);
    else if (flag === "--out") opts.out = resolve(value);
    else if (flag === "--timeout") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1)
        throw new Error(`--timeout wants a positive whole number, got "${value}"`);
      opts.timeout = n;
    } else throw new Error(`unrecognised flag: ${flag}\n\n${USAGE}`);
  }
  if (!opts.instance && !opts.instances)
    throw new Error(`--instance or --instances is required\n\n${USAGE}`);
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;
  const instances = opts.instance
    ? JSON.parse(readFileSync(opts.instance, "utf8"))
    : loadInstances(opts.instances);
  const list = Array.isArray(instances) ? instances : [instances];
  const validation = checkInstances(list);
  if (validation.length) {
    console.error(`REFUSED: ${validation.length} invalid instance(s)\n`);
    for (const p of validation) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  if (!opts.yes) {
    console.error(`[materialize] would clone and run, ${list.length} instance(s):`);
    for (const inst of list) console.error(`  ${inst.id}: ${inst.repro.command}  (${inst.repo})`);
    console.error("\nDRY RUN — nothing cloned or executed. Re-run with --yes.");
    process.exitCode = 3;
    return;
  }

  const temp = !opts.out;
  const root = opts.out ?? mkdtempSync(join(tmpdir(), "dt-bench-"));
  const reports = list.map((inst) => {
    // Worktree mode must sit inside the repo so the repro keeps node_modules.
    const dest =
      inst.mode === "worktree"
        ? join(resolve(inst.repo), ".dt-worktrees", inst.id)
        : join(root, inst.id);
    const report = materialize(inst, { dest, timeout: opts.timeout });
    if (inst.mode === "worktree") removeWorktree(resolve(inst.repo), dest);
    return report;
  });
  // The ledger lives outside `root` when the root is a temp dir that gets
  // deleted, or the path we print is already gone.
  const ledger = opts.out ? join(root, "materialize.jsonl") : join(WORK, "materialize.jsonl");
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, reports.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const failed = reports.filter((r) => !r.ok);
  console.log(
    JSON.stringify(
      {
        materialized: reports.length - failed.length,
        failed: failed.length,
        root,
        ledger,
        reports,
      },
      null,
      2,
    ),
  );
  if (temp && !opts.keep) rmSync(root, { recursive: true, force: true });
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (err) {
    console.error(`[materialize] ${err.message}`);
    process.exitCode = 2;
  }
}
