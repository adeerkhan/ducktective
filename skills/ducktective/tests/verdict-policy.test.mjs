/**
 * The verdict policy is the single source of the rule, and the schema must
 * agree with it. This file is the parity guard: it fails the day someone edits
 * `classify()` or the schema enum without the other (the bug BugTraceAI-CLI's
 * `statuses_aligned_with()` exists to prevent).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA, listCauses, readCases, writeCase } from "../scripts/lib/case-file.mjs";
import {
  CASE_STATUSES,
  CAUSE_CONFIDENCE_FLOOR,
  VERDICTS,
  candidateViolations,
  caseReportability,
  causeConfidence,
  causeIdentity,
  classifyVerdict,
  expectedVerdict,
  predictionHeld,
  alignedWith,
  whyViolations,
} from "../scripts/lib/verdict-policy.mjs";

const verdictEnum = SCHEMA.properties.candidates.items.properties.verdict.enum;
const statusEnum = SCHEMA.properties.status.enum;

test("the schema enums and the policy sets are the same set", () => {
  assert.ok(alignedWith(statusEnum, CASE_STATUSES), `status enum drifted: ${statusEnum}`);
  assert.ok(alignedWith(verdictEnum, VERDICTS), `verdict enum drifted: ${verdictEnum}`);
  assert.equal(alignedWith([...VERDICTS, "extra"], VERDICTS), false);
  assert.equal(alignedWith(CASE_STATUSES.slice(1), CASE_STATUSES), false);
  assert.equal(alignedWith(undefined, CASE_STATUSES), false);
});

test("prediction arithmetic is one function", () => {
  assert.equal(predictionHeld("fail", 1), true);
  assert.equal(predictionHeld("fail", 0), false);
  assert.equal(predictionHeld("pass", 0), true);
  assert.equal(expectedVerdict("fail", 1), "confirmed");
  assert.equal(expectedVerdict("pass", 1), "falsified");
});

/**
 * The table that matters: for every executed run, the classifier's verdict and
 * the store's refusal rules must agree about whether a candidate may claim
 * `confirmed`. A "confirmed" the classifier would not produce must be refused;
 * one it would produce must be storable (with a hypothesis and evidence).
 */
const BASE = {
  location: "app.py:1 f()",
  hypothesis: "returns one past the end",
  check: 'node -e "process.exit(1)"',
  evidence: "exit 1",
};

const RUNS = [
  {
    name: "fail prediction held with a passing control",
    predicted: "fail",
    check: { code: 1 },
    control: { code: 0 },
    disc: { controlPassed: true },
    candidate: {
      ...BASE,
      verdict: "confirmed",
      predicted: "fail",
      check_exit_code: 1,
      control_exit_code: 0,
    },
    confirmed: true,
  },
  {
    name: "fail prediction held with a flipped probe",
    predicted: "fail",
    check: { code: 1 },
    control: null,
    disc: { probeFlipped: true },
    candidate: {
      ...BASE,
      verdict: "confirmed",
      predicted: "fail",
      check_exit_code: 1,
      probe_flipped: "yes",
    },
    confirmed: true,
  },
  {
    name: "held but no receipt",
    predicted: "fail",
    check: { code: 1 },
    control: null,
    disc: {},
    candidate: { ...BASE, verdict: "confirmed", predicted: "fail", check_exit_code: 1 },
    confirmed: false,
  },
  {
    name: "pass prediction with only a control",
    predicted: "pass",
    check: { code: 0 },
    control: { code: 0 },
    disc: { controlPassed: true },
    candidate: {
      ...BASE,
      verdict: "confirmed",
      predicted: "pass",
      check_exit_code: 0,
      control_exit_code: 0,
    },
    confirmed: false,
  },
  {
    name: "prediction contradicted",
    predicted: "fail",
    check: { code: 0 },
    control: null,
    disc: {},
    candidate: { ...BASE, verdict: "confirmed", predicted: "fail", check_exit_code: 0 },
    confirmed: false,
  },
  {
    name: "control also failed",
    predicted: "fail",
    check: { code: 1 },
    control: { code: 1 },
    disc: { controlPassed: false },
    candidate: {
      ...BASE,
      verdict: "confirmed",
      predicted: "fail",
      check_exit_code: 1,
      control_exit_code: 1,
    },
    confirmed: false,
  },
];

for (const run of RUNS) {
  test(`classifier and store agree: ${run.name}`, () => {
    const classified = classifyVerdict(run.predicted, run.check, run.control, 0, run.disc);
    const wanted = classified.verdict === "confirmed";
    assert.equal(wanted, run.confirmed, `classifier said ${classified.verdict}`);
    // A candidate that claims `confirmed` must be refused exactly when the
    // classifier would not confirm it. (Other refusal reasons are fine to fire.)
    const violations = candidateViolations(run.candidate);
    const confirmedRefusal = violations.length > 0 && run.candidate.verdict === "confirmed";
    assert.equal(
      !confirmedRefusal,
      run.confirmed,
      `store ${run.confirmed ? "refused" : "accepted"} a confirmed claim: ${violations.join("; ")}`,
    );
  });
}

test("cause-confidence is arithmetic over receipts, never a self-report", () => {
  assert.equal(causeConfidence({ verdict: "falsified" }), 0);
  assert.equal(CAUSE_CONFIDENCE_FLOOR.confirmed, 0.5);
  assert.ok(
    causeConfidence({ verdict: "confirmed", control_exit_code: 0 }) >=
      CAUSE_CONFIDENCE_FLOOR.confirmed,
    "the weakest accepted receipt clears today's floor",
  );
  assert.ok(
    causeConfidence({ verdict: "confirmed", probe_flipped: "yes" }) >
      causeConfidence({ verdict: "confirmed", control_exit_code: 0 }),
    "a flip outranks a control",
  );
  assert.equal(
    causeConfidence({
      verdict: "confirmed",
      control_exit_code: 0,
      probe_flipped: "yes",
      verified_verdict: "confirmed",
    }),
    1,
  );
});

test("reportable is derived, and a non-confirmed case is never reportable", () => {
  const confirmed = {
    status: "confirmed",
    candidates: [{ verdict: "confirmed", control_exit_code: 0 }],
  };
  assert.equal(caseReportability(confirmed).reportable, true);
  assert.match(caseReportability({ ...confirmed, status: "unverified" }).reason, /not reportable/);
});

// --- cause identity and recurrence -----------------------------------------

function confirmedCase(overrides = {}) {
  return {
    id: "DT-260101-ab12",
    opened_at: "2026-01-01T00:00:00.000Z",
    symptom: "totals drop the last row",
    reproduction: {
      command: "python -m unittest -q",
      outcome: "reproduced",
      duration_ms: 12,
      exit_code: 1,
      stack: ['File "app.py", line 6, in total'],
    },
    candidates: [
      {
        rank: 1,
        location: "app.py:6 total()",
        why: "in the failing traceback",
        hypothesis: "end defaults to len(rows) - 1, dropping the final row",
        check: 'python -c "assert total([1,2,3,4]) == 10"',
        predicted: "fail",
        check_exit_code: 1,
        control_exit_code: 0,
        verdict: "confirmed",
        evidence: "AssertionError",
      },
    ],
    confirmed_cause: "end drops the last row",
    confidence: "high",
    status: "confirmed",
    notes: "",
    ...overrides,
  };
}

test("the same cause in two cases becomes a recurrence count", () => {
  const repo = mkdtempSync(join(tmpdir(), "dt-cause-"));
  try {
    writeCase(confirmedCase({ id: "DT-260101-aaaaaa" }), repo);
    const second = writeCase(confirmedCase({ id: "DT-260101-bbbbbb" }), repo);
    assert.equal(second.cause_count, 2, "the same cause must link, not duplicate");
    const causes = listCauses(repo);
    assert.equal(causes.length, 1);
    assert.equal(causes[0].count, 2);
    assert.deepEqual(causes[0].case_ids.sort(), ["DT-260101-aaaaaa", "DT-260101-bbbbbb"]);

    // A different location is a different cause.
    const other = confirmedCase({
      id: "DT-260101-cccccc",
      candidates: [{ ...confirmedCase().candidates[0], location: "other.py:9 total()" }],
    });
    writeCase(other, repo);
    assert.equal(listCauses(repo).length, 2);
    assert.equal(listCauses(repo)[0].count, 2, "most recurrent first");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rewriting one case does not inflate the recurrence count", () => {
  const repo = mkdtempSync(join(tmpdir(), "dt-cause-"));
  try {
    writeCase(confirmedCase({ id: "DT-260101-aaaaaa" }), repo);
    writeCase(confirmedCase({ id: "DT-260101-aaaaaa" }), repo);
    assert.equal(listCauses(repo)[0].count, 1);
    assert.equal(readCases(repo).length, 1, "one line per case id");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cause identity is stable across cosmetic differences and distinct across locations", () => {
  const a = causeIdentity(confirmedCase());
  const b = causeIdentity(confirmedCase({ id: "DT-260101-zzzzzz", symptom: "different words" }));
  assert.equal(a.hash, b.hash, "symptom wording is not part of the identity");
  const c = causeIdentity(
    confirmedCase({ candidates: [{ ...confirmedCase().candidates[0], location: "x.py:1 y()" }] }),
  );
  assert.notEqual(a.hash, c.hash);
});

// --- E5: why/evidence consistency ------------------------------------------

test("a why that cites a location in the case is consistent", () => {
  const c = confirmedCase();
  c.candidates[0].why = "app.py:6 is where the off-by-one bites";
  assert.deepEqual(whyViolations(c), []);
});

test("a why that cites a location nowhere in the case is flagged", () => {
  const c = confirmedCase();
  c.candidates[0].why = "the fault is really in utils.py:44";
  const out = whyViolations(c);
  assert.equal(out.length, 1);
  assert.match(out[0], /utils\.py:44/);
  assert.match(out[0], /not in this case's stack/);
});

test("a why that names no location makes no checkable claim", () => {
  const c = confirmedCase();
  c.candidates[0].why = "the nearest frame in the failing traceback";
  assert.deepEqual(whyViolations(c), []);
});

test("E5 matches on basename, so an absolute stack path satisfies a relative why", () => {
  const c = confirmedCase();
  c.reproduction.stack = ['File "C:\\src\\app.py", line 6, in total'];
  c.candidates[0].why = "app.py:6 drops the last row";
  assert.deepEqual(whyViolations(c), []);
});
