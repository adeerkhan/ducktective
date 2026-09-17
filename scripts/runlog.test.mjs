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
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.match(
    rep.stdout,
    /M2\. confirmed on the FIRST candidate\s+100%\s+\[2\/2\]\s+rank\u22642: 2/,
  );
  assert.match(rep.stdout, /M3\. claim survived --verify\s+0%\s+\[0\/1\]/);
});

test("the continue-branch threshold is first OR second, so the report prints both shares", (t) => {
  const { dir, log } = sandbox(t);
  const second = {
    rank: 2,
    location: "app.py:7 total()",
    hypothesis: "h",
    check: "c",
    verdict: "confirmed",
    evidence: "e",
    predicted: "fail",
    check_exit_code: 1,
  };
  rec(dir, log, "second.json", draft("DT-260101-ffff06", "reproduced", [second]));
  const rep = run(["--log", log, "--report"]);
  assert.equal(rep.status, 0, rep.stderr);
  // Rank 2 is not a first-candidate hit and is still a §9 success: reading only the
  // percentage would say the loop missed, reading only the tail would say it never did.
  assert.match(
    rep.stdout,
    /M2\. confirmed on the FIRST candidate\s+0%\s+\[0\/1\]\s+rank\u22642: 1/,
  );
});

// --- the blank-is-not-"no" rule --------------------------------------------

test("a flag with an unrecognised value is refused and records nothing", (t) => {
  const { dir, log } = sandbox(t);
  for (const [flag, bad] of [
    ["--changed-decision", "maybe"],
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
    /M1\. stopped correctly[^\n]*100%\s+\[1\/1\]/,
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
  const lines = rep.stdout.split("\n").filter((l) => /^\s+M\d+n?\./.test(l));
  // One block per group; the ledger is all-real, so a second block would repeat the
  // same numbers and read as twice the evidence. Four metrics now, because every
  // other one was a human transcribing their own run (M5–M9, deleted).
  assert.equal(lines.length, 4, `expected M1\u2013M4, got ${lines.join(" | ")}`);
  assert.ok(!/real rows only/.test(rep.stdout), "no second block when every row is already real");
  assert.ok(
    !/NaN|undefined|\[object/.test(rep.stdout),
    "a formatted number must never leak a bad value",
  );
});

test("re-logging a case refreshes its row, it does not count the bug twice", (t) => {
  // The ledger is one line per case id for the same reason the store is: the
  // investigation that gets re-recorded after --verify ran is the SAME run. Two
  // rows would double M2 and make a metric of one bug.
  const { dir, log } = sandbox(t);
  const first = draft("DT-260101-ff00ff", "reproduced", [
    { rank: 1, verdict: "confirmed", location: "app.py:1 f()" },
  ]);
  rec(dir, log, "c1.json", first, ["--provenance", "real"]);
  const again = rec(dir, log, "c2.json", {
    ...first,
    candidates: [{ ...first.candidates[0], verified_verdict: "confirmed" }],
  });
  assert.equal(JSON.parse(again.stdout).recorded, "DT-260101-ff00ff");
  const rows = rowsOf(log);
  assert.equal(rows.length, 1, "one case id, one row");
  assert.equal(rows[0].survived_verify, "yes", "the re-log carries the new fact");
  assert.equal(rows[0].provenance, "real", "and the answers typed for it");
});

const exists = (p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
};

test("the retired columns are refused, and say what replaced them", (t) => {
  // A flag that silently does nothing is worse than one that errors: the row would
  // look recorded while the answer evaporated. So the hand-transcribed columns
  // refuse, and point at the mechanical benchmark instead of the old prose metric.
  const { dir, log } = sandbox(t);
  // The flags are validated before the case file is even opened, so a refusal
  // cannot leave a half-written row behind.
  for (const flag of [
    "--opened",
    "--memory-changed",
    "--pair-case",
    "--tokens-plain",
    "--tokens-duck",
    "--wall-clock",
    "--duck-claim",
    "--plain-claim",
  ]) {
    const r = rec(dir, log, "r.json", draft("DT-260101-eeee09", "reproduced"), [flag, "yes"]);
    assert.equal(r.status, 2, `${flag} must be refused`);
    assert.match(r.stderr, /retired with the hand-transcribed columns/);
  }
  assert.ok(!exists(log), "a refused record must not append a row");
});

test("a legacy row's retired keys survive a re-record and stay out of the report", (t) => {
  // History is not rewritten to fit a smaller schema: RUNLOG.jsonl keeps whatever
  // the old columns recorded, read() maps absent fields to empty, and the report
  // no longer computes anything from them.
  const { dir, log } = sandbox(t);
  const c = draft("DT-260101-eeee10", "reproduced", [
    { rank: 1, verdict: "confirmed", location: "app.py:1 f()" },
  ]);
  rec(dir, log, "legacy.json", c, ["--changed-decision", "yes"]);
  const rows = rowsOf(log);
  appendFileSync(
    log,
    JSON.stringify({ ...rows[0], tokens_duck: 1500, human_opened: "yes" }) +
      String.fromCharCode(10),
    "utf8",
  );
  const rep = run(["--log", log, "--report"]);
  assert.equal(rep.status, 0, rep.stderr);
  assert.ok(!/tokens|human_opened|M5|M6|M7|M8|M9/.test(rep.stdout), rep.stdout);
  assert.equal(
    rec(dir, log, "again.json", {
      ...c,
      candidates: [{ ...c.candidates[0], verified_verdict: "confirmed" }],
    }).status,
    0,
  );
  const kept = rowsOf(log).filter((r) => r.case_id === "DT-260101-eeee10");
  assert.equal(kept.length, 1, "one row per case id, retired keys or not");
  assert.equal(kept[0].survived_verify, "yes");
});
