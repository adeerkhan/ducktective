#!/usr/bin/env node
/**
 * The benchmark arm runner (design §4, Phase 1).
 *
 * For each instance it materialises the buggy checkout once — the materialiser
 * has already verified that the gold hunks are real and the repro fails — then
 * runs each arm in its own throwaway copy and scores the claim the arm writes.
 * Two arms, same command, same budget: the only difference the runner injects is
 * `DT_ARM`, so the agent decides for itself whether it uses the skill.
 *
 *   node bench/run.mjs --instance i.json --agent-cmd "claude -p ..." --out work/ --yes
 *   node bench/run.mjs --instances corpus/ --arm both --yes
 *
 * **Agent contract.** The command runs with cwd = the checkout and these env
 * vars; it must write a JSON claim to `$DT_OUT` (or write nothing to abstain):
 *
 *   DT_REPO      the checkout to investigate        DT_ARM    "A" (bare) or "B" (skill)
 *   DT_REPRO     the failing command                DT_OUT    where to write claim.json
 *   DT_INSTANCE  the instance id
 *
 *   claim.json = { "file": "src/app.py", "line": 41, "cause": "...",
 *                  "reportable": true, "abstained": false, "tokens": 1234 }
 *
 * The arm never sees the gold hunks. `reportable` is the C2 signal: a reportable
 * cause that misses every gold hunk is a false confirm. Exit 0 when the run
 * completed; 1 on invalid input; 2 on a harness error; 3 on a dry run.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkInstances, loadInstances, materialize } from "./materialize.mjs";
import { computeMetrics } from "./report.mjs";
import { HARNESSES, agentCommand, detectHarness } from "./agents.mjs";
import { childEnv } from "../skills/ducktective/scripts/lib/exec.mjs";

/** Where this file lives — the target of the `{bench}` placeholder below. */
const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
/** Gitignored scratch for ledgers when no --out is given. */
const WORK = join(BENCH_DIR, "..", "evals", ".work");

export const USAGE = `usage: run.mjs (--instance FILE | --instances DIR) [--agent NAME] [options]
  --instance FILE   one instance spec (JSON)
  --instances DIR   every *.json in DIR
  --agent NAME      harness to run the arms: ${Object.keys(HARNESSES).join(", ")} (default: detect)
  --agent-cmd CMD   escape hatch for any other harness; runs with cwd = the clone,
                    so use {bench} for this folder. Wins over --agent.
  --arm A|B|both    which arm(s) to run (default: both)
  --out DIR         where to materialise and write results.jsonl (default: temp)
  --keep            keep the temp output directory (--out is always kept)
  --timeout MS      kill one arm after this long (default: 600000)
  --yes             actually clone, run the arms and score them`;

/** Does the claimed location fall inside a gold bug-fix hunk? */
export function causeHit(goldHunks, file, line) {
  if (!file || !Number.isFinite(line)) return false;
  const want = basename(String(file));
  return (goldHunks ?? []).some(
    (h) => basename(String(h.file)) === want && line >= h.start && line <= h.end,
  );
}

/** One result row from one arm's claim. Absent claim = an abstention by silence. */
export function scoreClaim(instance, arm, claim, wallMs) {
  const row = {
    instance: instance.id,
    arm,
    status: "ok",
    claim: null,
    confirmed: false,
    cause_hit: false,
    abstained: false,
    tokens: null,
    wall_ms: wallMs,
  };
  if (!claim) {
    row.status = "no-claim";
    row.abstained = true;
    return row;
  }
  const line = Number(claim.line);
  row.claim = { file: claim.file ?? null, line: Number.isFinite(line) ? line : null };
  row.abstained = claim.abstained === true;
  row.confirmed = !row.abstained && claim.reportable === true;
  row.tokens = Number.isFinite(Number(claim.tokens)) ? Number(claim.tokens) : null;
  row.cause_hit = causeHit(instance.expect?.goldHunks, claim.file, line);
  return row;
}

function readClaim(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const opts = { arm: "both", timeout: 600_000, yes: false, keep: false };
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
    else if (flag === "--agent-cmd") opts.agentCmd = value;
    else if (flag === "--agent") {
      if (!(value in HARNESSES))
        throw new Error(
          `--agent must be one of ${Object.keys(HARNESSES).join(", ")}, got "${value}"`,
        );
      opts.agent = value;
    } else if (flag === "--out") opts.out = resolve(value);
    else if (flag === "--arm") {
      if (!["A", "B", "both"].includes(value))
        throw new Error(`--arm must be A, B or both, got "${value}"`);
      opts.arm = value;
    } else if (flag === "--timeout") {
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

function runAgent(command, { cwd, env, timeout }) {
  const started = Date.now();
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    windowsHide: true,
    env,
    timeout,
  });
  return {
    code: r.error ? null : r.status,
    error: r.error?.message ?? null,
    wallMs: Date.now() - started,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;
  const raw = opts.instance
    ? JSON.parse(readFileSync(opts.instance, "utf8"))
    : loadInstances(opts.instances);
  const instances = Array.isArray(raw) ? raw : [raw];
  const validation = checkInstances(instances);
  if (validation.length) {
    console.error(`REFUSED: ${validation.length} invalid instance(s)\n`);
    for (const p of validation) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  const arms = opts.arm === "both" ? ["A", "B"] : [opts.arm];

  if (!opts.yes) {
    console.error(`[run] would run ${arms.length} arm(s) over ${instances.length} instance(s):`);
    console.error(`  agent: ${opts.agentCmd ? "custom" : (opts.agent ?? "(auto-detect)")}`);
    for (const inst of instances)
      console.error(`  ${inst.id}: ${inst.repro.command}  arms ${arms.join(", ")}`);
    console.error("\nDRY RUN — nothing cloned or executed. Re-run with --yes.");
    process.exitCode = 3;
    return;
  }

  // Resolved only after approval: detection spawns the agent CLI.
  const harness = opts.agentCmd ? null : (opts.agent ?? detectHarness());
  if (!opts.agentCmd && !harness)
    throw new Error(
      `no agent harness detected on PATH — pass --agent ${Object.keys(HARNESSES).join("|")}, or --agent-cmd "<command>"`,
    );
  const agentCmd = (opts.agentCmd ?? agentCommand(harness)).replaceAll("{bench}", BENCH_DIR);

  const temp = !opts.out;
  const root = opts.out ?? mkdtempSync(join(tmpdir(), "dt-run-"));
  const rows = [];
  for (const instance of instances) {
    const base = join(root, instance.id, "base");
    const mat = materialize(instance, { dest: base, timeout: opts.timeout });
    if (!mat.ok) {
      for (const arm of arms) {
        rows.push({
          instance: instance.id,
          arm,
          status: "materialize-failed",
          claim: null,
          confirmed: false,
          cause_hit: false,
          abstained: false,
          tokens: null,
          wall_ms: 0,
          problems: mat.problems,
        });
      }
      continue;
    }
    for (const arm of arms) {
      const armDir = join(root, instance.id, arm);
      const repo = join(armDir, "repo");
      mkdirSync(armDir, { recursive: true });
      cpSync(base, repo, { recursive: true });
      const claimPath = join(armDir, "claim.json");
      if (existsSync(claimPath)) rmSync(claimPath, { force: true });
      const run = runAgent(agentCmd, {
        cwd: repo,
        env: {
          ...childEnv(),
          DT_REPO: repo,
          DT_ARM: arm,
          DT_REPRO: instance.repro.command,
          DT_OUT: claimPath,
          DT_INSTANCE: instance.id,
        },
        timeout: opts.timeout,
      });
      if (run.error || run.code === null) {
        // A crashed or missing agent is a harness failure, not an abstention:
        // scoring it as "no claim" would inflate C3 and hide a broken arm.
        rows.push({
          instance: instance.id,
          arm,
          status: "agent-error",
          claim: null,
          confirmed: false,
          cause_hit: false,
          abstained: false,
          tokens: null,
          wall_ms: run.wallMs,
          problems: [run.error ?? "the agent command was signalled"],
        });
        continue;
      }
      rows.push(scoreClaim(instance, arm, readClaim(claimPath), run.wallMs));
    }
  }

  // The ledger lives outside a temp `root` that gets deleted, or its path is dead.
  const ledger = opts.out ? join(root, "results.jsonl") : join(WORK, "results.jsonl");
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const metrics = { all: computeMetrics(rows) };
  for (const arm of arms) metrics[`arm_${arm}`] = computeMetrics(rows.filter((r) => r.arm === arm));
  console.log(JSON.stringify({ rows: rows.length, root, ledger, metrics }, null, 2));
  if (temp && !opts.keep) rmSync(root, { recursive: true, force: true });
  const failed = rows.filter(
    (r) => r.status === "materialize-failed" || r.status === "agent-error",
  ).length;
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (err) {
    console.error(`[run] ${err.message}`);
    process.exitCode = 2;
  }
}
