#!/usr/bin/env node
/**
 * ducktective check — grade a root-cause claim the agent already made.
 *
 *   node scripts/check.mjs \
 *     --claim "candidate.py:411 returns None when the cache is cold" \
 *     --repro "pytest tests/test_cache.py::test_cold -x" \
 *     --check "python -c 'from candidate import get; assert get(cold=True)'" --predict fail \
 *     --control "pytest tests/test_cache.py::test_warm -x" --yes
 *
 * This is the shape design v2 §2 asks for: not a protocol to follow in order, but
 * one command that grades a belief at the end. It composes the other four tools
 * and invents nothing itself — every row is a fact one of them produced, and a row
 * nobody attempted says `n/a` rather than passing quietly.
 *
 *   reproduces           the gate ran the repro and it failed in this repo
 *   regression           bisect found the first bad commit (regressions only)
 *   claim ∈ commit       that commit's hunks contain the accused line  ← the one that
 *                        catches "right file, wrong function", which is where the
 *                        published numbers say agents actually fail
 *   check discriminates  --probe flipped when the accused line was deleted
 *   control              --control passed on the known-good path
 *   prediction           --predict agreed with the executed exit code
 *   survives re-run      --verify re-ran the claim and it held
 *
 * Nothing runs without `--yes`: before that this prints every command it would
 * execute. A grade is never "asserted" — an unattempted row is `n/a` and counts
 * against the denominator, which is the whole point of a receipt.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoRoot } from "./lib/case-file.mjs";
import { numFlag } from "./lib/args.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = (name) => join(HERE, name);

const USAGE = `usage: check.mjs --claim TEXT --repro CMD [options]
  --claim TEXT      the root-cause claim, as "file:line <what it says>"
  --repro CMD       the command that fails while the bug is present
  --check CMD       the falsifying check (enables the probe / prediction rows)
  --predict pass|fail  what --check must do if the claim is true
  --control CMD     known-good path that must pass, or the check is not an oracle
  --repo DIR        repo under test (default: walk up to .git from here)
  --skip-bisect     do not search history (no green ancestor, or not a repo)
  --budget SEC      bisect cost ceiling (default 300)
  --timeout MS      per-command timeout (default 120000)
  --out FILE        write the draft + result here (default .ducktective/check-<n>.json)
  --yes             run it; without this the commands are printed and nothing executes`;

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return null;
  }
  const opts = { budget: 300, timeout: 120_000, yes: false, bisect: true };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`expected a --flag, got "${flag}"\n\n${USAGE}`);
    if (flag === "--yes") {
      opts.yes = true;
      continue;
    }
    if (flag === "--skip-bisect") {
      opts.bisect = false;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value\n\n${USAGE}`);
    switch (flag) {
      case "--claim":
        opts.claim = value;
        break;
      case "--repro":
        opts.repro = value;
        break;
      case "--check":
        opts.check = value;
        break;
      case "--predict":
        if (value !== "pass" && value !== "fail")
          throw new Error("--predict is pass or fail: what the check must do if the claim is true");
        opts.predict = value;
        break;
      case "--control":
        opts.control = value;
        break;
      case "--repo":
        opts.repo = resolve(value);
        break;
      case "--budget":
        opts.budget = numFlag(flag, value, { min: 0 });
        break;
      case "--timeout":
        opts.timeout = numFlag(flag, value);
        break;
      case "--out":
        opts.out = resolve(value);
        break;
      default:
        throw new Error(`unrecognised flag: ${flag}\n\n${USAGE}`);
    }
  }
  if (!opts.claim) throw new Error(`--claim is required: this tool grades a claim\n\n${USAGE}`);
  if (!opts.repro)
    throw new Error(
      `--repro is required: without a failing command there is nothing to grade\n\n${USAGE}`,
    );
  if (opts.check && !opts.predict)
    throw new Error("--check needs --predict: a check with no declared direction is not an oracle");
  if (!opts.repo) opts.repo = repoRoot(process.cwd());
  return opts;
}

/** `file:line` out of a claim, tolerating a trailing description. */
export function claimLocation(claim) {
  const m = /([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)/.exec(claim ?? "");
  return m ? { file: m[1], line: Number(m[2]) } : null;
}

/**
 * Rows: [id, label, state, evidence]. `state` is one of
 *   "yes"   — a tool proved it
 *   "no"    — a tool disproved it
 *   "n/a"   — nobody attempted it (counts against the denominator)
 * Grade counts only `yes`. There is no "asserted" state: a claim cannot earn a
 * point by being stated confidently, which is the entire difference between this
 * and a summary paragraph.
 */
export function grade(rows) {
  const earned = rows.filter(([, , s]) => s === "yes").length;
  const disproved = rows.filter(([, , s]) => s === "no").length;
  const ratio = rows.length ? earned / rows.length : 0;
  // A hunk miss is not a disproof: an enabling commit can expose an older bug.
  // A contradicted check or failed re-run must not be averaged into a good grade.
  const contradicted = rows.some(
    ([id, , s]) => ["prediction", "survives"].includes(id) && s === "no",
  );
  const repro = rows.find(([id]) => id === "reproduces")?.[2];
  // A stale ticket is not a bad grade. Refusing to name a cause for something that
  // does not reproduce is the behaviour this project exists to reward (design v2
  // §4's C3), so there is nothing to grade and the note says so. A harness that
  // never ran at all is a different thing again.
  const letter =
    contradicted || repro === "n/a"
      ? "F"
      : repro === "no"
        ? "n/a"
        : ratio >= 0.9
          ? "A"
          : ratio >= 0.7
            ? "B"
            : ratio >= 0.5
              ? "C"
              : "D";
  return {
    earned,
    disproved,
    total: rows.length,
    letter,
    wrongCause: false,
    contradicted,
    note:
      repro === "no"
        ? "no defect to grade in this run: the symptom did not reproduce; this does not prove the ticket stale"
        : "Evidence-completeness grade only; not a probability or proof of root cause.",
  };
}

const MARK = { yes: "✓", no: "✗", "n/a": "·" };

export function renderBox(rows, { claim, caseId } = {}) {
  const width = Math.max(...rows.map(([, label]) => label.length));
  const lines = rows.map(([, label, state, evidence]) =>
    `  ${label.padEnd(width)}  ${MARK[state]}  ${evidence ?? ""}`.trimEnd(),
  );
  const g = grade(rows);
  const unattempted = rows.filter(([, , s]) => s === "n/a").length;
  lines.push(`  ${"─".repeat(width + 34)}`);
  lines.push(
    `  GRADE: ${g.letter}   (${g.earned}/${g.total} earned, ${unattempted} not attempted` +
      `${g.disproved ? `, ${g.disproved} disproved` : ""})${caseId ? `   case ${caseId}` : ""}`,
  );
  if (g.note) lines.push(`  note: ${g.note}`);
  if (claim) lines.push(`  claim: ${claim}`);
  return lines.join("\n");
}

/** Run one child tool and parse its JSON stdout. Failures are data, not crashes. */
function tool(args, cwd) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* a tool that printed no JSON: json stays null and the caller says n/a */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;
  const repo = opts.repo;
  const store = join(repo, ".ducktective");
  const out = opts.out ?? join(store, "check.json");
  const draftPath = join(store, "draft.json");
  const loc = claimLocation(opts.claim);

  const plan = [
    [
      "reproduce",
      [
        TOOL("reproduce.mjs"),
        "--cmd",
        opts.repro,
        "--symptom",
        opts.claim,
        "--out",
        draftPath,
        "--timeout",
        String(opts.timeout),
      ],
    ],
  ];
  if (opts.bisect)
    plan.push([
      "bisect",
      [
        TOOL("bisect.mjs"),
        "--cmd",
        opts.repro,
        "--claim",
        opts.claim,
        "--budget",
        String(opts.budget),
        "--yes",
      ],
    ]);
  if (opts.check)
    plan.push([
      "run_check",
      [
        TOOL("run_check.mjs"),
        "--file",
        draftPath,
        "--candidate",
        "1",
        "--predict",
        opts.predict,
        "--cmd",
        opts.check,
        "--probe",
        ...(opts.control ? ["--control", opts.control] : []),
        "--yes",
      ],
    ]);

  if (!opts.yes) {
    console.error("[check] this is what would run, in order:\n");
    for (const [name, args] of plan)
      console.error(
        `  ${name}: ${args
          .slice(1)
          .filter((a) => a !== "--yes")
          .join(" ")}`,
      );
    console.error("\nDRY RUN — nothing executed.");
    // The approval instruction goes on stdout, with the machine output, and
    // never on stderr: an agent that scrapes the printed plan and re-executes
    // it must not find the approval flag already attached to it.
    console.log(
      JSON.stringify({ planned: true, approve_with: "--yes", steps: plan.map(([n]) => n) }),
    );
    process.exitCode = 3;
    return;
  }

  const rows = [];
  // 1. the gate. A non-reproduction is the end of it: no claim to grade.
  const repro = tool(plan[0][1], repo);
  const r = repro.json;
  const outcome = r?.reproduction?.outcome ?? "error";
  const frames = r?.reproduction?.stack?.length ?? 0;
  const reproduced = outcome === "reproduced";
  rows.push([
    "reproduces",
    "reproduces",
    reproduced ? "yes" : outcome === "does_not_reproduce" ? "no" : "n/a",
    `\`${outcome}\`, exit ${r?.reproduction?.exit_code ?? "?"}, ${frames} in-repo frames`,
  ]);

  let bisect = null;
  if (reproduced && opts.bisect) {
    console.error("[check] searching history for the commit that broke it…");
    const b = tool(plan.find(([n]) => n === "bisect")[1], repo);
    bisect = b.json;
    if (bisect?.bisected)
      rows.push([
        "regression",
        "regression",
        "yes",
        `${bisect.first_bad_commit.short} ${JSON.stringify(bisect.first_bad_commit.subject)} (${bisect.estimated_runs} runs)`,
      ]);
    else
      rows.push([
        "regression",
        "regression",
        "n/a",
        bisect?.reason ? String(bisect.reason).slice(0, 70) : "history search produced nothing",
      ]);
    const ci = bisect?.claim_in_commit;
    if (ci === "yes" || ci === "no") rows.push(["claim", "claim ∈ commit", ci, bisect.claim_why]);
    else rows.push(["claim", "claim ∈ commit", "n/a", bisect?.claim_why ?? "no commit to compare"]);
  } else if (reproduced) {
    rows.push(["regression", "regression", "n/a", "--skip-bisect"]);
    rows.push(["claim", "claim ∈ commit", "n/a", "--skip-bisect"]);
  }

  // 2. the check, with the probe, when one was given.
  if (reproduced && opts.check) {
    const seeded = JSON.parse(readFileSync(draftPath, "utf8"));
    seeded.candidates = [
      {
        rank: 1,
        location: loc ? `${loc.file}:${loc.line}` : (seeded.candidates?.[0]?.location ?? "unknown"),
        why: "the location the claim accuses",
        hypothesis: opts.claim,
        check: opts.check,
        verdict: "pending",
        evidence: "",
      },
    ];
    writeFileSync(draftPath, JSON.stringify(seeded, null, 2), "utf8");
    console.error("[check] running the check, a control if given, and the probe…");
    const c = tool(plan.find(([n]) => n === "run_check")[1], repo);
    const cand = c.json;
    const verdict = cand?.verdict ?? "inconclusive";
    rows.push([
      "discriminates",
      "check discriminates",
      cand?.probe_flipped === "yes" ? "yes" : cand?.probe_flipped === "no" ? "no" : "n/a",
      cand?.probe_flipped === "yes"
        ? "neutering the accused line moved the check"
        : cand?.probe_flipped === "no"
          ? "the check ignored the accused line — inconclusive_vacuous"
          : "not probed, or the probe could not run",
    ]);
    rows.push([
      "control",
      "control",
      opts.control ? (cand?.control_exit_code === 0 ? "yes" : "no") : "n/a",
      opts.control ? `exit ${cand?.control_exit_code}` : "no --control given",
    ]);
    rows.push([
      "prediction",
      "prediction",
      verdict === "confirmed" ? "yes" : verdict === "falsified" ? "no" : "n/a",
      `${opts.predict} vs exit ${cand?.check_exit_code ?? "?"} ⇒ ${verdict}`,
    ]);
    if (verdict === "confirmed") {
      console.error("[check] re-running the claim to see whether it survives…");
      const v = tool(
        [TOOL("run_check.mjs"), "--file", draftPath, "--candidate", "1", "--verify", "--yes"],
        repo,
      );
      const survived = v.json?.survived === true;
      rows.push(["survives", "survives re-run", survived ? "yes" : "no", v.json?.caveat ?? ""]);
    } else {
      rows.push(["survives", "survives re-run", "n/a", "nothing was confirmed to re-run"]);
    }
  } else if (reproduced) {
    rows.push(["discriminates", "check discriminates", "n/a", "--check not given"]);
    rows.push(["control", "control", "n/a", "--check not given"]);
    rows.push(["prediction", "prediction", "n/a", "--check not given"]);
    rows.push(["survives", "survives re-run", "n/a", "--check not given"]);
  }

  // 3. store it, so the grade has a receipt behind it.
  let caseId = null;
  if (existsSync(draftPath)) {
    const w = tool([TOOL("write_case.mjs"), "--file", draftPath], repo);
    caseId = w.json?.id ?? null;
    if (!w.json?.stored)
      rows.push([
        "stored",
        "case file",
        "n/a",
        String(w.stderr ?? "")
          .split("\n")[0]
          .slice(0, 70),
      ]);
  }

  const table = {
    claim: opts.claim,
    repro: opts.repro,
    repo,
    check: opts.check ?? null,
    bisect,
    rows: rows.map(([id, label, state, evidence]) => ({ id, label, state, evidence })),
    grade: grade(rows),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(table, null, 2) + "\n", "utf8");
  // Prose to stderr, machine-readable to stdout — the convention every other tool
  // here follows, and the reason a caller parses this without guessing where the box
  // ends.
  console.error(renderBox(rows, { claim: opts.claim, caseId }));
  console.log(JSON.stringify({ graded: true, case: caseId, letter: table.grade.letter, out }));
  process.exitCode = 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
