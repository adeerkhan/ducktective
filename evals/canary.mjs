#!/usr/bin/env node
/**
 * Tier-1 mutation canary (design v3 §2).
 *
 * Mutation testing gives an infinite supply of bugs with exact ground truth: the
 * mutated line *is* the root cause, by construction, the moment a test kills the
 * mutant. This harness mutates a target module, keeps the mutants the target's
 * own test command kills, feeds the failing command to `reproduce.mjs`, and
 * scores whether the spine's first lead is the line it just broke.
 *
 *   node evals/canary.mjs [--target DIR] [--file NAME] [--cmd CMD]
 *                         [--max N] [--out FILE] [--timeout MS]
 *
 * **Say the limit out loud.** Mutants are systematically easier and
 * differently-shaped than real faults: a one-token swap is not a missing null
 * check written under deadline pressure, and tools over-fit to mutant-shaped
 * bugs. This is a **regression alarm** and a gross-breakage detector for the
 * candidate ranking — it is never evidence the product works on real bugs.
 * (The probe is deliberately not scored here: every mutant baseline is already
 * failing, so neutering an essential line usually keeps it failing and the
 * pass/fail flip the probe looks for does not occur. That needs the benchmark's
 * passing baselines, not a mutant.)
 * That claim needs the Tier-2 benchmark, and only Tier-2.
 *
 * It is also a two-kind signal on purpose. A mutant that *throws* leaves its own
 * line in the traceback, so `cause_hit` is meaningful. A mutant that silently
 * returns a wrong value fails the assertion at the *test* line, so the traceback
 * cannot name the mutated line — that gap is the coverage prior's whole job, and
 * the per-kind summary keeps the two from averaging into one misleading number.
 *
 * Exit 0 when the run completed (whatever the rate); 2 on a broken baseline.
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

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPRODUCE = join(HERE, "..", "skills", "ducktective", "scripts", "reproduce.mjs");

export const USAGE = `usage: canary.mjs [options]
  --target DIR   directory to copy and mutate (default: evals/canary/target)
  --file NAME    module to mutate, relative to --target (default: calc.mjs)
  --cmd CMD      the target's test command, run in the copy (default: node --test calc.test.mjs)
  --max N        stop after N mutants (default: 25)
  --out FILE     write the JSONL ledger here (default: evals/.work/canary.jsonl)
  --timeout MS   kill a single command after this long (default: 120000)`;

/**
 * The mutation operators. `throw-return` replaces a `return <expr>;` with a
 * throw, which is deliberately the one kind that leaves the mutated line in the
 * traceback; the rest are value and control-flow swaps.
 */
export const PATTERNS = Object.freeze([
  { kind: "throw-return", re: /\breturn\s+[^;]+;/, to: 'throw new Error("dt-canary");' },
  // Lookbehinds keep `===`, `!==`, `<=`, `>=` and arrow `=>` out of each other's
  // matches: `>(?!=)` alone rewrites the `>` in `=>` and the mutant never parses.
  { kind: "strict-eq", re: /===/, to: "!==" },
  { kind: "strict-neq", re: /!==/, to: "===" },
  { kind: "loose-eq", re: /(?<![=!])==(?!=)/, to: "!=" },
  { kind: "loose-neq", re: /(?<![=!])!=(?!=)/, to: "==" },
  { kind: "le", re: /(?<![<>=])<=/, to: "<" },
  { kind: "ge", re: /(?<![<>=])>=/, to: ">" },
  { kind: "lt", re: /(?<![<=])<(?![<=])/, to: "<=" },
  { kind: "gt", re: /(?<![=<>])>(?![=>])/, to: ">=" },
  { kind: "and", re: /&&/, to: "||" },
  { kind: "or", re: /\|\|/, to: "&&" },
  { kind: "true", re: /\btrue\b/, to: "false" },
  { kind: "false", re: /\bfalse\b/, to: "true" },
]);

/**
 * Every mutation site in a source, one per (line, operator). Comment lines are
 * skipped; a token-level mutator cannot see strings or templates, and that limit
 * is why a mutant that fails to parse is skipped rather than scored.
 */
export function planMutations(source) {
  const lines = String(source ?? "").split(/\r?\n/);
  const out = [];
  lines.forEach((text, i) => {
    const t = text.trim();
    if (!t || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return;
    for (const pattern of PATTERNS) {
      const m = pattern.re.exec(text);
      if (m) out.push({ line: i + 1, kind: pattern.kind, before: m[0], after: pattern.to });
    }
  });
  return out;
}

/** Apply one planned mutation, changing exactly one line. */
export function applyMutation(source, mutation) {
  const pattern = PATTERNS.find((p) => p.kind === mutation.kind);
  if (!pattern) throw new Error(`unknown mutation kind: ${mutation.kind}`);
  const lines = String(source ?? "").split(/\r?\n/);
  if (mutation.line < 1 || mutation.line > lines.length)
    throw new Error(`mutation line ${mutation.line} is outside the source`);
  lines[mutation.line - 1] = lines[mutation.line - 1].replace(pattern.re, () => pattern.to);
  return lines.join("\n");
}

/** A mutation runs clean, breaks the test, times out, or could not be run. */
export function classify(result) {
  if (result?.timedOut) return "timeout";
  if (result?.error || result?.code === null) return "error";
  return result.code === 0 ? "survived" : "killed";
}

/** Does the first seeded lead name the line the canary broke? */
export function causeHit(candidates, file, line) {
  const top = candidates?.[0]?.location ?? "";
  const m = /^(\S+?):(\d+)/.exec(top);
  if (!m) return false;
  return basename(m[1]) === basename(file) && Number(m[2]) === line;
}

function pct(num, den) {
  return { num, den, pct: den > 0 ? Math.round((num / den) * 100) : null };
}

/** One row is one mutant. `cause_hit` is only meaningful for killed mutants. */
export function summarise(rows) {
  const killed = rows.filter((r) => r.status === "killed");
  const survived = rows.filter((r) => r.status === "survived");
  const invalid = rows.filter((r) => r.status === "invalid");
  const errored = rows.filter((r) => r.status === "timeout" || r.status === "error");
  const byKind = {};
  for (const row of rows) {
    const k = (byKind[row.kind] ??= { killed: 0, cause_hits: 0, survived: 0, errored: 0 });
    if (row.status === "killed") {
      k.killed += 1;
      if (row.cause_hit) k.cause_hits += 1;
    } else if (row.status === "survived") k.survived += 1;
    else if (row.status === "timeout" || row.status === "error") k.errored += 1;
  }
  for (const k of Object.values(byKind)) k.cause_hit_rate = pct(k.cause_hits, k.killed);
  return {
    mutants: rows.length,
    killed: killed.length,
    survived: survived.length,
    invalid: invalid.length,
    errored: errored.length,
    cause_hit: pct(killed.filter((r) => r.cause_hit).length, killed.length),
    // A survivor is the equivalent-mutant check: only a real
    // `does_not_reproduce` counts. An errored/`no-draft` seed also has zero
    // candidates and must not be scored as good.
    survived_no_candidate: pct(
      survived.filter((r) => r.outcome === "does_not_reproduce").length,
      survived.length,
    ),
    byKind,
  };
}

/**
 * A nested `node --test` that inherits `NODE_TEST_*` exits 0 and prints nothing,
 * which would make every mutant read as "survived" the moment the canary itself
 * runs under `npm test`. Strip the runner's own plumbing from every child.
 */
function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^NODE_TEST_/i.test(key)) delete env[key];
  return env;
}

function run(command, cwd, timeout) {
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    windowsHide: true,
    env: childEnv(),
    timeout,
  });
  return {
    code: r.status,
    error: r.error ? r.error.message : null,
    timedOut: r.error?.code === "ETIMEDOUT",
  };
}

/** Syntax check without a shell, so a `--file` value cannot inject a command. */
function checkSyntax(file, cwd, timeout) {
  const r = spawnSync(process.execPath, ["--check", file], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: childEnv(),
    timeout,
  });
  return {
    code: r.status,
    error: r.error ? r.error.message : null,
    timedOut: r.error?.code === "ETIMEDOUT",
  };
}

function seed(cmd, cwd, timeout) {
  const r = spawnSync(
    process.execPath,
    [REPRODUCE, "--cmd", cmd, "--cwd", cwd, "--symptom", "canary mutant"],
    { cwd, encoding: "utf8", windowsHide: true, env: childEnv(), timeout },
  );
  try {
    const draft = JSON.parse(r.stdout);
    return {
      outcome: draft.reproduction?.outcome ?? "unknown",
      candidates: draft.candidates ?? [],
    };
  } catch {
    return { outcome: "no-draft", candidates: [] };
  }
}

function parseArgs(argv) {
  const opts = {
    target: join(HERE, "canary", "target"),
    file: "calc.mjs",
    cmd: "node --test calc.test.mjs",
    max: 25,
    out: join(HERE, ".work", "canary.jsonl"),
    timeout: 120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      return null;
    }
    const value = argv[++i];
    if (!flag.startsWith("--") || value === undefined)
      throw new Error(`unrecognised argument: ${flag}\n\n${USAGE}`);
    switch (flag) {
      case "--target":
        opts.target = resolve(value);
        break;
      case "--file":
        opts.file = value;
        break;
      case "--cmd":
        opts.cmd = value;
        break;
      case "--max": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1)
          throw new Error(`--max wants a positive whole number, got "${value}"`);
        opts.max = n;
        break;
      }
      case "--out":
        opts.out = resolve(value);
        break;
      case "--timeout": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1)
          throw new Error(`--timeout wants a positive whole number of ms, got "${value}"`);
        opts.timeout = n;
        break;
      }
      default:
        throw new Error(`unrecognised flag: ${flag}\n\n${USAGE}`);
    }
  }
  return opts;
}

const COPY_SKIP = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  ".tox",
  ".nox",
  "__pycache__",
  "dist",
]);

function copyTarget(target) {
  const dir = mkdtempSync(join(tmpdir(), "dt-canary-"));
  cpSync(target, dir, {
    recursive: true,
    // Dependencies and history are irrelevant to a one-line mutant and would
    // turn the copy into hundreds of megabytes on a real repo.
    filter: (src) => !COPY_SKIP.has(basename(src)),
  });
  return dir;
}

/** `--file` names a path inside `--target`; reject an escape before it is used. */
export function safeRelativeFile(file) {
  if (
    !file ||
    file.startsWith("/") ||
    /^[A-Za-z]:/.test(file) ||
    file.split(/[\\/]/).includes("..")
  )
    throw new Error(`--file must be a relative path inside --target, got "${file}"`);
  return file;
}

/** The baseline must pass, or every mutant reads as killed for the wrong reason. */
export function baselinePasses(opts) {
  const dir = copyTarget(opts.target);
  try {
    return run(opts.cmd, dir, opts.timeout).code === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;
  safeRelativeFile(opts.file);
  const sourcePath = join(opts.target, opts.file);
  if (!existsSync(sourcePath)) throw new Error(`no such target file: ${sourcePath}`);
  if (!baselinePasses(opts))
    throw new Error(`the baseline does not pass: \`${opts.cmd}\` in ${opts.target}`);

  const source = readFileSync(sourcePath, "utf8");
  const mutations = planMutations(source).slice(0, opts.max);
  const rows = [];
  for (const mutation of mutations) {
    const dir = copyTarget(opts.target);
    try {
      writeFileSync(join(dir, opts.file), applyMutation(source, mutation), "utf8");
      const check = checkSyntax(opts.file, dir, opts.timeout);
      if (check.code !== 0) {
        rows.push({ ...mutation, file: opts.file, status: "invalid" });
        continue;
      }
      const test = run(opts.cmd, dir, opts.timeout);
      const status = classify(test);
      const row = {
        ...mutation,
        file: opts.file,
        status,
        outcome: "n/a",
        candidates: 0,
        cause_hit: false,
      };
      if (status === "killed" || status === "survived") {
        // Seed both kinds: a survivor is the equivalent-mutant check — a green
        // suite must produce `does_not_reproduce` and zero candidates, not a
        // hallucinated lead.
        const seeded = seed(opts.cmd, dir, opts.timeout);
        row.outcome = seeded.outcome;
        row.candidates = seeded.candidates.length;
        if (status === "killed")
          row.cause_hit = causeHit(seeded.candidates, opts.file, mutation.line);
      }
      rows.push(row);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const s = summarise(rows);
  console.log(`\nDucktective mutation canary — ${opts.file} in ${opts.target}\n`);
  console.log(
    `  mutants: ${s.mutants}  killed: ${s.killed}  survived: ${s.survived}  invalid: ${s.invalid}  errored: ${s.errored}`,
  );
  console.log(
    `  cause-hit@1 (killed mutants)   ${s.cause_hit.pct === null ? "no data" : `${s.cause_hit.pct}%  [${s.cause_hit.num}/${s.cause_hit.den}]`}`,
  );
  console.log(
    `  survived with no candidate     ${s.survived_no_candidate.pct === null ? "no data" : `${s.survived_no_candidate.pct}%  [${s.survived_no_candidate.num}/${s.survived_no_candidate.den}]`}`,
  );
  for (const [kind, k] of Object.entries(s.byKind))
    console.log(
      `    ${kind.padEnd(14)} killed ${k.killed}, cause-hit ${k.cause_hit_rate.pct === null ? "n/a" : `${k.cause_hit_rate.pct}%`}, survived ${k.survived}, errored ${k.errored}`,
    );
  console.log(`\n  Ledger: ${opts.out}`);
  console.log(
    "  Mutants are an easier target than real faults: this is a regression alarm, not product evidence.\n",
  );
  process.exitCode = 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(`[canary] ${err.message}`);
    process.exitCode = 2;
  });
}
