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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  const head = git(["rev-parse", "HEAD"], dest).out;

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

  const repro = runCommand(instance.repro.command, dest, timeout);
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
  return { id, ok: true, problems: [], dir: dest, head, repro_exit: repro.code };
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
  const reports = list.map((inst) =>
    materialize(inst, { dest: join(root, inst.id), timeout: opts.timeout }),
  );
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
