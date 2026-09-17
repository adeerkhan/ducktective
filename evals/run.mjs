#!/usr/bin/env node
/**
 * The Week-1 stress run: does the gate do what the doc says it does?
 *
 *   npm run eval            # all cases
 *   npm run eval -- pytest  # only cases whose directory matches
 *
 * Each case is a directory under `evals/cases/` with a `case.json` describing
 * one real command and what the gate must conclude. Nothing here measures model
 * quality — that needs a host agent and a human. What it does measure is the
 * doc's first, hardest metric: **% of investigations that stop correctly on
 * non-reproducing cases**, plus the neighbouring failure modes (a broken command
 * dressed up as a reproduction, a caller ranked above the function that threw).
 *
 * Cases run with their own directory as cwd, so a stray pytest at the repo root
 * can wander into `ref/` and collect 115 numpy errors. It must not be able to.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CASES = join(HERE, "cases");
const REPRODUCE = join(REPO, "skills", "ducktective", "scripts", "reproduce.mjs");
/** Scratch for drafts and coverage artifacts; never inside a case directory. */
const WORK = join(HERE, ".work");
mkdirSync(WORK, { recursive: true });

/** The eval venv if it exists — the corpus needs pytest and coverage.py. */
function python() {
  const candidates = [
    { exe: join(REPO, ".venv-eval", "Scripts", "python.exe"), mustExist: true },
    { exe: join(REPO, ".venv-eval", "bin", "python"), mustExist: true },
    { exe: process.env.DUCKTECTIVE_PYTHON, mustExist: false },
    { exe: "python", mustExist: false },
    { exe: "python3", mustExist: false },
  ].filter((c) => c.exe && (!c.mustExist || existsSync(c.exe)));
  for (const { exe } of candidates) {
    const probe = spawnSync(exe, ["-c", "import sys"], { encoding: "utf8", windowsHide: true });
    if (!probe.error && probe.status === 0) return exe;
  }
  return null;
}

function tool(args, cwd) {
  const run = spawnSync(process.execPath, [REPRODUCE, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  let draft = null;
  try {
    draft = JSON.parse(run.stdout);
  } catch {
    /* reported below as a harness failure */
  }
  return { code: run.status, draft, stderr: run.stderr, stdout: run.stdout };
}

const baseName = (file) => (file ?? "").split("/").pop();

/**
 * Does the lead list start where the fault is?
 *
 * The raw frame line differs per runner (`File "…", line 7, in total`,
 * `at fn (file:1:2)`, `test_money.py:5: AssertionError`), so ask the tool's own
 * normalized location instead of parsing evidence a second time.
 */
function ranksFaultFirst(draft, expectedFile) {
  const lead = draft?.candidates?.[0]?.location ?? "";
  return baseName(lead.split(":")[0]) === expectedFile;
}

function check(c, draft, code) {
  const problems = [];
  const e = c.expect ?? {};
  const got = draft?.reproduction?.outcome;
  if (got !== e.outcome)
    problems.push(
      `outcome: expected "${e.outcome}", got "${got ?? "no JSON"}" (harness exit ${code})`,
    );
  if (e.runner && draft?.reproduction?.runner !== e.runner)
    problems.push(`runner: expected "${e.runner}", got "${draft?.reproduction?.runner}"`);
  if (e.firstFrameFile && !ranksFaultFirst(draft, e.firstFrameFile)) {
    problems.push(
      `nearest fault: expected ${e.firstFrameFile} first, got lead "${draft?.candidates?.[0]?.location ?? "no candidates"}"`,
    );
  }
  if (e.candidates === 0 && (draft?.candidates?.length ?? -1) !== 0)
    problems.push(`a stopped case must carry zero candidates, got ${draft?.candidates?.length}`);
  if (e.outcome === "reproduced" && !(draft?.candidates?.length > 0))
    problems.push("reproduced with no seeded candidates");
  if (e.coverageLines && !(draft?.reproduction?.covered?.length > 0))
    problems.push("--coverage/--baseline produced no fail-only sites");
  return problems;
}

/** Real coverage.py artifacts for the cases that ask for them. */
function prepareCoverage(c, py, cwd) {
  const cov = c.coverage;
  if (!cov) return [];
  const extra = [];
  for (const [phase, file] of [
    ["baseline", cov.baseline],
    ["failing", cov.failing],
  ]) {
    // `.coverage` accumulates across runs, which would make the two phases report
    // identical line sets and the fail-only diff empty. Each phase starts clean.
    rmSync(join(cwd, ".coverage"), { force: true });
    // The run's own exit is not the signal: a failing test under coverage is exactly
    // what the corpus wants. Only `coverage json` failing is an error here.
    spawnSync(py, ["-m", "coverage", "run", "-m", "pytest", "-q", file], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    const out = spawnSync(py, ["-m", "coverage", "json", "-q", "-o", `cov-${phase}.json`], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (out.status !== 0) extra.push(`coverage ${phase}: ${out.stderr.slice(0, 120)}`);
  }
  return extra;
}

function cmdFor(c, py) {
  return c.cmd.replaceAll("{py}", `"${py}"`).replaceAll("{node}", `"${process.execPath}"`);
}

function main() {
  const filter = process.argv[2];
  const py = python();
  const names = readdirSync(CASES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(CASES, d.name, "case.json")))
    .map((d) => d.name)
    .filter((n) => !filter || n.includes(filter));

  const rows = [];
  for (const name of names) {
    const cwd = join(CASES, name);
    const c = JSON.parse(readFileSync(join(cwd, "case.json"), "utf8"));
    if (c.cmd.includes("{py}") && !py) {
      rows.push({ name, c, skipped: "no python", problems: [] });
      continue;
    }
    const setup = prepareCoverage(c, py, cwd);
    if (setup.length) {
      rows.push({ name, c, failed: setup.join("; "), problems: setup });
      continue;
    }
    const args = [
      "--cmd",
      cmdFor(c, py),
      "--cwd",
      ".",
      "--symptom",
      c.name,
      "--out",
      join(WORK, `${name}.json`),
    ];
    if (c.coverage) args.push("--coverage", "cov-failing.json", "--baseline", "cov-baseline.json");
    const res = tool(args, cwd);
    const problems = res.draft
      ? check(c, res.draft, res.code)
      : [`no JSON on stdout; stderr: ${res.stderr.slice(0, 200)}`];
    rows.push({ name, c, draft: res.draft, code: res.code, problems });
  }

  // --- the metrics the doc asks for, limited to what a harness can measure ---
  const run = rows.filter((r) => !r.skipped);
  // Two different claims hid inside "stop-correctness", and the doc asks about
  // only one of them ("does the Skill stop on non-reproducing symptoms? must be
  // near 100%"). Merged, four broken-command refusals carried a metric that
  // needs two stale tickets.
  const stale = run.filter((r) => r.c.expect?.outcome === "does_not_reproduce");
  const staleStopped = stale.filter((r) => r.code === 1);
  const broken = run.filter((r) => r.c.expect?.outcome === "error");
  const brokenRefused = broken.filter((r) => r.code === 2);
  const repro = run.filter((r) => r.c.expect?.outcome === "reproduced");
  const ranked = repro.filter((r) => !r.problems.some((p) => p.startsWith("nearest fault")));
  const ok = run.filter((r) => r.problems.length === 0);

  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");
  console.log(
    `\nDucktective gate — ${run.length} real cases${rows.length - run.length ? ` (${rows.length - run.length} skipped)` : ""}\n`,
  );
  for (const r of run) {
    const mark = r.problems.length ? "FAIL" : "pass";
    console.log(
      `  ${mark.padEnd(4)} ${r.name.padEnd(22)} ${(r.draft?.reproduction?.outcome ?? r.failed ?? "").padEnd(20)} ${r.problems[0] ?? ""}`,
    );
  }
  console.log(`
  stale tickets stopped before any investigation:      ${pct(staleStopped.length, stale.length)}  [${staleStopped.length}/${stale.length}]
  broken commands refused instead of "reproduced":     ${pct(brokenRefused.length, broken.length)}  [${brokenRefused.length}/${broken.length}]
  nearest-fault ranking (throw site above its caller):     ${pct(ranked.length, repro.length)}  [${ranked.length}/${repro.length}]
  cases fully as expected:                                 ${pct(ok.length, run.length)}  [${ok.length}/${run.length}]

  Not measured here: whether the protocol beats a bare "fix this" prompt. That is a
  comparison against a corpus with known answers, not a property of these fixtures —
  see docs/ducktective-design.md §4. This corpus is a regression net, not evidence.`);
  process.exitCode = ok.length === run.length && run.length > 0 ? 0 : 1;
}

main();
