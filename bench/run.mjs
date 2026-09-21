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
import { spawn, spawnSync } from "node:child_process";
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
import {
  addWorktree,
  checkInstances,
  loadInstances,
  materialize,
  removeWorktree,
} from "./materialize.mjs";
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
  --split dev|heldout|all   which corpus split to run (default: dev; the held-out
                    third stays untouched unless you ask for it by name)
  --concurrency N   run at most N instances at once (default: 1)
  --budget-tokens N stop starting arms once this many tokens have been reported
  --budget-ms N     stop starting arms once this much wall clock has passed
  --run-id ID       the date/identity stamped on every row (default: today)
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
  const opts = {
    arm: "both",
    timeout: 600_000,
    yes: false,
    keep: false,
    concurrency: 1,
    split: "dev",
  };
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
    } else if (flag === "--split") {
      if (!["dev", "heldout", "all"].includes(value))
        throw new Error(`--split must be dev, heldout or all, got "${value}"`);
      opts.split = value;
    } else if (flag === "--concurrency") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1)
        throw new Error(`--concurrency wants a positive whole number, got "${value}"`);
      opts.concurrency = n;
    } else if (flag === "--budget-tokens" || flag === "--budget-ms") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0)
        throw new Error(`${flag} wants a positive number, got "${value}"`);
      if (flag === "--budget-tokens") opts.budgetTokens = n;
      else opts.budgetMs = n;
    } else if (flag === "--run-id") opts.runId = value;
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

/** A row for an arm the budget stopped before it started. */
const SKIP_STATUS = "skipped-budget";

function skipRow(instance, arm, meta) {
  return {
    ...meta,
    instance: instance.id,
    arm,
    status: SKIP_STATUS,
    claim: null,
    confirmed: false,
    cause_hit: false,
    abstained: false,
    tokens: null,
    wall_ms: 0,
    problems: ["budget exhausted before this arm started"],
  };
}

/** A wall-clock and token budget shared by every arm in one run. */
export function makeBudget({ maxTokens = null, maxMs = null } = {}) {
  const startedAt = Date.now();
  return {
    tokens: 0,
    maxTokens,
    maxMs,
    get ms() {
      return Date.now() - startedAt;
    },
    exhausted() {
      if (maxTokens != null && this.tokens >= maxTokens) return true;
      if (maxMs != null && this.ms >= maxMs) return true;
      return false;
    },
  };
}

/** Run `worker` over `items` with at most `limit` in flight; keeps input order. */
export async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  let active = 0;
  return new Promise((resolveAll) => {
    const launch = () => {
      if (active === 0 && next >= items.length) return resolveAll(out);
      while (active < limit && next < items.length) {
        const i = next++;
        active++;
        Promise.resolve()
          .then(() => worker(items[i], i))
          .then((rows) => {
            out[i] = rows;
          })
          .finally(() => {
            active--;
            launch();
          });
      }
    };
    launch();
  });
}

/** Kill a process and its children. On Windows a shell spawn outlives `kill()`. */
function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
}

/** One arm's agent process, async so a bounded pool can overlap them. */
function runAgent(command, { cwd, env, timeout }) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env });
    let out = "";
    let errOut = "";
    child.stdout?.on("data", (d) => {
      out += d;
    });
    child.stderr?.on("data", (d) => {
      errOut += d;
    });
    let error = null;
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeout)
      : null;
    child.on("error", (err) => {
      error = err.message;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolveRun({
        code: error ? null : code,
        error: error ?? (timedOut ? `timed out after ${timeout} ms` : null),
        wallMs: Date.now() - started,
        // The last 2KB of the agent's own output: enough to say why it died,
        // small enough to keep the ledger readable.
        log: `${out}\n${errOut}`.trim().slice(-2000),
      });
    });
  });
}

/** A plain-text metrics table for the terminal; JSON stays the machine format. */
export function formatTable(metrics, arms) {
  const pct = (r) => (r.pct === null ? "no data" : `${r.pct}%`);
  const lines = [
    ["arm", "rows", "C1 hit", "C2 false-confirm", "C3 abstain", "C4 tok/row", "C5 ms/row"].join(
      "\t",
    ),
  ];
  for (const arm of arms) {
    const m = metrics[`arm_${arm}`];
    lines.push(
      [
        arm,
        m.rows,
        pct(m.C1_cause_hit),
        pct(m.C2_false_confirm),
        pct(m.C3_abstention),
        m.C4_tokens.mean ?? "-",
        m.C5_wall_ms.mean ?? "-",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

/** Materialise one instance and run its arms, returning the rows in arm order. */
async function runInstance(instance, ctx) {
  const { arms, agentCmd, root, timeout, budget, runId, model, agentName } = ctx;
  const meta = { run: runId, model, agent: agentName, split: instance.split ?? "dev" };
  const rows = [];
  const failedRows = (problems) =>
    arms.map((arm) => ({
      ...meta,
      instance: instance.id,
      arm,
      status: "materialize-failed",
      claim: null,
      confirmed: false,
      cause_hit: false,
      abstained: false,
      tokens: null,
      wall_ms: 0,
      problems,
    }));
  const worktreeMode = instance.mode === "worktree";
  const repoAbs = resolve(instance.repo);
  // A per-run tag: a crashed run can leave locked files behind (an agent host may
  // keep cwd handles in the arm checkout), and a fixed name would collide with
  // them on the next run. Stale tagged dirs never collide; cleanup removes them
  // when the locks release.
  const tag = ctx.tag ?? "notag";
  const base = worktreeMode
    ? join(repoAbs, ".dt-worktrees", `${instance.id}-base-${tag}`)
    : join(root, instance.id, "base");
  const made = [];
  try {
    if (budget.exhausted()) return arms.map((arm) => skipRow(instance, arm, meta));

    const mat = materialize(instance, { dest: base, timeout });
    if (!mat.ok) {
      return failedRows(mat.problems);
    }
    for (const arm of arms) {
      if (budget.exhausted()) {
        rows.push(skipRow(instance, arm, meta));
        continue;
      }
      const armDir = join(root, instance.id, arm);
      // Worktree arms must sit inside the repo, or the repro loses node_modules.
      const repo = worktreeMode
        ? join(repoAbs, ".dt-worktrees", `${instance.id}-${arm}-${ctx.tag ?? "notag"}`)
        : join(armDir, "repo");
      mkdirSync(armDir, { recursive: true });
      if (worktreeMode) {
        // The worktree sits inside the repo so the repro keeps node_modules.
        const added = addWorktree(repoAbs, instance.commit, repo);
        if (!added.ok) {
          rows.push({
            ...meta,
            instance: instance.id,
            arm,
            status: "agent-error",
            claim: null,
            confirmed: false,
            cause_hit: false,
            abstained: false,
            tokens: null,
            wall_ms: 0,
            agent_exit: null,
            agent_log: added.problem,
            problems: [added.problem],
          });
          continue;
        }
        made.push(repo);
      } else {
        cpSync(base, repo, { recursive: true });
      }
      const claimPath = join(armDir, "claim.json");
      if (existsSync(claimPath)) rmSync(claimPath, { force: true });
      const run = await runAgent(agentCmd, {
        cwd: repo,
        env: {
          ...childEnv(),
          DT_REPO: repo,
          DT_ARM: arm,
          DT_REPRO: instance.repro?.command ?? instance.oracle?.command,
          DT_OUT: claimPath,
          DT_INSTANCE: instance.id,
        },
        timeout,
      });
      if (run.error || run.code === null) {
        // A crashed or missing agent is a harness failure, not an abstention:
        // scoring it as "no claim" would inflate C3 and hide a broken arm.
        rows.push({
          ...meta,
          instance: instance.id,
          arm,
          status: "agent-error",
          claim: null,
          confirmed: false,
          cause_hit: false,
          abstained: false,
          tokens: null,
          wall_ms: run.wallMs,
          agent_exit: run.code,
          agent_log: run.log,
          problems: [run.error ?? "the agent command was signalled"],
        });
        continue;
      }
      const claim = readClaim(claimPath);
      if (!claim && run.code !== 0) {
        // Exited badly and wrote nothing: a broken arm, not an abstention.
        rows.push({
          ...meta,
          instance: instance.id,
          arm,
          status: "agent-error",
          claim: null,
          confirmed: false,
          cause_hit: false,
          abstained: false,
          tokens: null,
          wall_ms: run.wallMs,
          agent_exit: run.code,
          agent_log: run.log,
          problems: [`the agent exited ${run.code} without writing a claim`],
        });
        continue;
      }
      const row = scoreClaim(instance, arm, claim, run.wallMs);
      budget.tokens += Number(row.tokens) || 0;
      rows.push({
        ...meta,
        ...row,
        agent_exit: run.code,
        ...(row.status === "ok" ? {} : { agent_log: run.log }),
        oracle_verified: !!mat.oracle_verified,
      });
    }
  } catch (err) {
    // One instance's infrastructure failure must not kill a thirty-instance run
    // or lose every other row: it becomes rows that say what broke.
    for (const dir of made) {
      try {
        if (instance.mode === "worktree") removeWorktree(resolve(instance.repo), dir);
      } catch {
        /* cleanup is best-effort */
      }
    }
    return failedRows([
      `instance infrastructure failure: ${String(err?.message ?? err).slice(0, 300)}`,
    ]);
  } finally {
    if (worktreeMode) for (const dir of [base, ...made]) removeWorktree(repoAbs, dir);
  }
  return rows;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;
  const raw = opts.instance
    ? JSON.parse(readFileSync(opts.instance, "utf8"))
    : loadInstances(opts.instances);
  const all = Array.isArray(raw) ? raw : [raw];
  const validation = checkInstances(all);
  if (validation.length) {
    console.error(`REFUSED: ${validation.length} invalid instance(s)\n`);
    for (const p of validation) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  const instances = all.filter((i) => opts.split === "all" || (i.split ?? "dev") === opts.split);
  if (!instances.length) {
    console.error(`[run] no instances in split "${opts.split}" (${all.length} in the corpus)`);
    process.exitCode = 1;
    return;
  }
  const arms = opts.arm === "both" ? ["A", "B"] : [opts.arm];
  const budgetLabel =
    opts.budgetTokens == null && opts.budgetMs == null
      ? "none"
      : `${opts.budgetTokens ?? "unlimited"} tokens / ${opts.budgetMs ?? "unlimited"} ms`;

  if (!opts.yes) {
    console.error(`[run] would run ${arms.length} arm(s) over ${instances.length} instance(s)`);
    console.error(
      `  split: ${opts.split}   concurrency: ${opts.concurrency}   budget: ${budgetLabel}`,
    );
    console.error(`  agent: ${opts.agentCmd ? "custom" : (opts.agent ?? "(auto-detect)")}`);
    for (const inst of instances)
      console.error(
        `  ${inst.id}: ${inst.repro?.command ?? inst.oracle?.command}  arms ${arms.join(", ")}`,
      );
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
  const agentName = opts.agentCmd ? "custom" : harness;
  const runId = opts.runId ?? new Date().toISOString().slice(0, 10);

  const temp = !opts.out;
  const root = opts.out ?? mkdtempSync(join(tmpdir(), "dt-run-"));
  const budget = makeBudget({ maxTokens: opts.budgetTokens, maxMs: opts.budgetMs });
  const tag = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const results = await pool(instances, opts.concurrency, (instance) =>
    runInstance(instance, {
      arms,
      agentCmd,
      root,
      timeout: opts.timeout,
      budget,
      runId,
      model: process.env.DT_MODEL ?? null,
      agentName,
      tag,
    }),
  );
  const rows = results.flat();

  // The ledger lives outside a temp `root` that gets deleted, or its path is dead.
  const ledger = opts.out ? join(root, "results.jsonl") : join(WORK, "results.jsonl");
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const metrics = { all: computeMetrics(rows) };
  for (const arm of arms) metrics[`arm_${arm}`] = computeMetrics(rows.filter((r) => r.arm === arm));
  const bySplit = {};
  for (const s of new Set(rows.map((r) => r.split)))
    bySplit[s] = computeMetrics(rows.filter((r) => r.split === s));
  const skipped = rows.filter((r) => r.status === SKIP_STATUS).length;

  console.log(
    JSON.stringify(
      {
        run: runId,
        model: process.env.DT_MODEL ?? null,
        agent: agentName,
        split: opts.split,
        concurrency: opts.concurrency,
        budget: {
          max_tokens: opts.budgetTokens ?? null,
          max_ms: opts.budgetMs ?? null,
          tokens_spent: budget.tokens,
          wall_ms: budget.ms,
          skipped_rows: skipped,
        },
        rows: rows.length,
        root,
        ledger,
        metrics,
        by_split: bySplit,
      },
      null,
      2,
    ),
  );
  // stdout stays one JSON document; the human table goes to stderr.
  console.error(formatTable(metrics, arms));
  if (temp && !opts.keep) rmSync(root, { recursive: true, force: true });
  const failed = rows.filter(
    (r) => r.status === "materialize-failed" || r.status === "agent-error",
  ).length;
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main();
  } catch (err) {
    console.error(`[run] ${err.message}`);
    process.exitCode = 2;
  }
}
