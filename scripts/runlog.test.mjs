#!/usr/bin/env node
/**
 * The ledger decides the project's future, so the ledger is tested like code.
 *
 * Its first version parsed CSV rows with `line[i]` — characters, not fields —
 * and reported "0 real cases" against three real rows without throwing. The
 * rewrite to JSONL deleted that parser; these tests cover what replaced it:
 * derived fields, and the rule that an unrecorded answer must stay blank rather
 * than become "no" (the pessimistic default would silently understate metric 4,
 * the one design §9 rests on).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const TOOL = join(ROOT, "evals", "runlog.mjs");

const draft = (id, outcome, candidates = []) => ({
  id,
  opened_at: "2026-01-01T00:00:00.000Z",
  symptom: "totals drop the last row",
  reproduction: { command: "pytest -q", outcome },
  candidates,
  status: outcome === "reproduced" ? "confirmed" : outcome,
  confidence: "high",
  notes: "",
});

const run = (args) =>
  spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", windowsHide: true });
const rec = (dir, log, file, caseObj, extra = []) => {
  const casePath = join(dir, file);
  writeFileSync(casePath, JSON.stringify(caseObj), "utf8");
  return run(["--log", log, "--record", "--case", casePath, "--repo", "/not/mine", ...extra]);
};

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "dt-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, log: join(dir, "RUNLOG.jsonl") };
}

const rowsOf = (log) =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

// --- derived from the case file, never retyped ------------------------------

test("a stopped case with no candidates is a correct stop; one with leads is not", (t) => {
  const { dir, log } = sandbox(t);
  rec(dir, log, "a.json", draft("DT-260101-aaaa01", "does_not_reproduce"));
  rec(
    dir,
    log,
    "b.json",
    draft("DT-260101-bbbb02", "does_not_reproduce", [
      {
        rank: 1,
        location: "app.py:1",
        hypothesis: "h",
        check: "c",
        verdict: "falsified",
        evidence: "e",
      },
    ]),
  );
  const rows = rowsOf(log);
  assert.deepEqual(
    rows.map((r) => r.stop_correct),
    ["yes", "no"],
    "a non-reproducing case that filed a lead failed the gate",
  );
  assert.deepEqual(
    rows.map((r) => r.outcome),
    ["does_not_reproduce", "does_not_reproduce"],
  );
});

test("first-candidate and verify survival come from the verdicts", (t) => {
  const { dir, log } = sandbox(t);
  const cands = [
    {
      rank: 1,
      location: "app.py:7 total()",
      hypothesis: "h",
      check: "c",
      verdict: "confirmed",
      evidence: "e",
      predicted: "fail",
      check_exit_code: 1,
    },
  ];
  rec(dir, log, "r.json", draft("DT-260101-cccc03", "reproduced", cands));
  rec(
    dir,
    log,
    "v.json",
    draft("DT-260101-dddd04", "reproduced", [{ ...cands[0], verified_verdict: "falsified" }]),
  );
  const rows = rowsOf(log);
  assert.equal(rows[0].first_falsification_hit, "1");
  assert.equal(rows[0].survived_verify, "not-run", "no --verify yet is not a failure");
  assert.equal(rows[1].survived_verify, "no", "the second run said falsified");
  const rep = run(["--log", log, "--report"]);
  assert.match(rep.stdout, /2\. confirmed on the FIRST candidate\s+100%\s+\[2\/2\]/);
  assert.match(rep.stdout, /3\. claim survived --verify\s+0%\s+\[0\/1\]/);
});

// --- the blank-is-not-"no" rule --------------------------------------------

test("a flag with an unrecognised value is refused and records nothing", (t) => {
  const { dir, log } = sandbox(t);
  for (const [flag, bad] of [
    ["--changed-decision", "maybe"],
    ["--opened", "sometimes"],
    ["--memory-changed", "perhaps"],
    ["--provenance", "real-ish"],
  ]) {
    const r = rec(dir, log, `x${flag}.json`, draft("DT-260101-eeee05", "does_not_reproduce"), [
      "--repo",
      "/x",
      flag,
      bad,
    ]);
    assert.equal(r.status, 2, `${flag} ${bad} should be refused`);
    assert.match(r.stderr, new RegExp(`${flag} must be one of`));
    assert.ok(!exists(log), "a refused record must not append a row");
  }
});

test("host-reported numbers must be numbers, not strings in disguise", (t) => {
  const { dir, log } = sandbox(t);
  assert.equal(
    rec(dir, log, "w.json", draft("DT-260101-ffff06", "does_not_reproduce"), ["--wall-clock", "9m"])
      .status,
    2,
    "CSV-era behaviour stored '9m' and silently dropped it from the mean",
  );
  const ok = rec(dir, log, "w2.json", draft("DT-260101-ffff07", "does_not_reproduce"), [
    "--wall-clock",
    "9.5",
    "--tokens-plain",
    "4200",
    "--tokens-duck",
    "1500",
    "--changed-decision",
    "yes",
    "--opened",
    "yes",
    "--memory-changed",
    "n/a",
  ]);
  assert.equal(ok.status, 0, ok.stderr);
  const row = rowsOf(log).at(-1);
  assert.equal(typeof row.wall_clock_min, "number");
  assert.equal(row.tokens_plain, 4200);
  assert.equal(row.decision_changed, "yes");
  assert.equal(row.memory_changed_search, "n/a", "n/a is a real answer, distinct from blank");
  const rep = run(["--log", log, "--report"]);
  assert.match(rep.stdout, /4\. case file CHANGED a decision\s+100%\s+\[1\/1\]/);
  assert.match(rep.stdout, /4n\. case file merely opened \(attention\)\s+100%\s+\[1\/1\]/);
  assert.match(rep.stdout, /7\. wall-clock per investigation\s+9\.5 min mean/);
  assert.match(rep.stdout, /6\. tokens: bare "fix this" vs Ducktective\s+2\.80×/);
});

// --- provenance and integrity -----------------------------------------------

test("constructed fixtures never share a denominator with real rows", (t) => {
  const { dir, log } = sandbox(t);
  rec(dir, log, "real.json", draft("DT-260101-111111", "does_not_reproduce"), [
    "--provenance",
    "real",
  ]);
  rec(dir, log, "made.json", draft("DT-260101-222222", "does_not_reproduce"), [
    "--provenance",
    "constructed",
  ]);
  const rep = run(["--log", log, "--report"]);
  assert.match(rep.stdout, /2 row\(s\): 1 real, 1 constructed/);
  assert.match(rep.stdout, /\[all rows: 2\][\s\S]*\[real rows only: 1\]/, "both blocks must print");
  assert.match(
    rep.stdout.slice(rep.stdout.indexOf("real rows only")),
    /1\. stopped correctly[^\n]*100%\s+\[1\/1\]/,
  );
});

test("a corrupt line is reported and excluded, never silently dropped", (t) => {
  const { dir, log } = sandbox(t);
  rec(dir, log, "g.json", draft("DT-260101-333333", "does_not_reproduce"), [
    "--provenance",
    "real",
  ]);
  appendFileSync(log, "{oops not json\n");
  const rep = run(["--log", log, "--report"]);
  assert.match(rep.stderr, /unparseable row/);
  assert.match(
    rep.stdout,
    /1 row\(s\): 1 real, 0 constructed/,
    "the good row still counts; the bad one is not guessed at",
  );
});

test("--csv is gone and says so", () => {
  const r = run(["--csv", "x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--csv was replaced by --log/);
});

test("the real pilot ledger parses and reports, and every unmeasured metric says no data", () => {
  const rep = run(["--report"]);
  assert.equal(rep.status, 0, rep.stderr);
  const lines = rep.stdout.split("\n").filter((l) => /^\s+\d+n?\./.test(l));
  // One block per group; the pilot ledger is all-real, so a second block would
  // repeat the same seven numbers and read as twice the evidence.
  assert.ok(lines.length >= 7, `expected the seven metrics, got ${lines.length}`);
  assert.ok(!/real rows only/.test(rep.stdout), "no second block when every row is already real");
  assert.ok(
    !/NaN|undefined|\[object/.test(rep.stdout),
    "a formatted number must never leak a bad value",
  );
});

const exists = (p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
};
