import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA,
  clip,
  policyViolations,
  validateSchema,
  writeCase,
  readCases,
} from "../scripts/lib/case-file.mjs";

/** A case file that survived real execution — the shape we want to allow. */
function confirmed(overrides = {}) {
  return {
    id: "DT-260101-ab12",
    opened_at: "2026-01-01T00:00:00.000Z",
    symptom: "totals are short by the last row on inclusive ranges",
    reproduction: {
      command: "python -m unittest -q",
      outcome: "reproduced",
      duration_ms: 412,
      exit_code: 1,
      stdout: "",
      stderr: "AssertionError: 6 != 10",
      stack: ['File "app.py", line 6, in total'],
      covered: [{ file: "app.py", line: 6 }],
      runner: "unittest",
    },
    candidates: [
      {
        rank: 1,
        location: "app.py:6 total()",
        why: "appears in the failing traceback",
        hypothesis: "total() should sum every row, but end defaults to len(rows) - 1",
        check: 'python -c "assert total([1,2,3,4]) == 10"',
        predicted: "fail",
        check_exit_code: 1,
        control: 'python -c "import app"',
        control_exit_code: 0,
        verdict: "confirmed",
        evidence: "AssertionError: 6 != 10",
        blind_check: {
          verdict: "confirmed",
          check: 'python -c "from app import total; assert total([1,2,3,4]) == 10"',
          exit_code: 1,
          evidence: "AssertionError: 6 != 10",
        },
      },
    ],
    confirmed_cause: "end defaults to len(rows) - 1, dropping the final row",
    leading_hypothesis: null,
    confidence: "high",
    suggested_patch: null,
    status: "confirmed",
    notes: "",
    ...overrides,
  };
}

const problems = (c) => [...validateSchema(c, SCHEMA), ...policyViolations(c)];

test("a case backed by execution is accepted and stored in both formats", () => {
  const repo = mkdtempSync(join(tmpdir(), "dt-store-"));
  try {
    const c = confirmed();
    assert.deepEqual(problems(c), []);
    const { jsonl, markdown } = writeCase(c, repo);
    const stored = readFileSync(jsonl, "utf8").trim().split("\n");
    assert.equal(stored.length, 1);
    assert.deepEqual(JSON.parse(stored[0]), c);
    const md = readFileSync(markdown, "utf8");
    assert.match(md, /# DT-260101-ab12/);
    // Blank lines are structure: without them the "30 second read" is one wall.
    assert.match(md, /\n\n## Symptom\n\n/);
    assert.match(md, /\n\n## Candidates\n\n/);
    assert.match(md, /\*\*Confirmed cause:\*\*/);
    assert.match(md, /AssertionError: 6 != 10/);
    assert.deepEqual(
      readCases(repo).map((x) => x.id),
      ["DT-260101-ab12"],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("re-writing the same id updates the store instead of duplicating it", () => {
  const repo = mkdtempSync(join(tmpdir(), "dt-store-"));
  try {
    writeCase(
      confirmed({
        status: "open",
        confidence: "none",
        candidates: [{ ...confirmed().candidates[0], verdict: "pending" }],
      }),
      repo,
    );
    const again = writeCase(confirmed(), repo);
    assert.equal(again.replaced, true);
    assert.equal(
      readFileSync(join(repo, ".ducktective", "cases.jsonl"), "utf8")
        .trim()
        .split("\n").length,
      1,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a confirmed verdict owes a discrimination receipt, not just agreement", () => {
  // predicted + exit code prove the check AGREED; control_exit_code === 0 proves
  // it is not always-fail; probe_flipped === "yes" proves the outcome depends on
  // the accused line. A `confirmed` with none of the last two is the confident
  // wrong answer this skill exists to catch, in its own oracle.
  const bare = confirmed();
  delete bare.candidates[0].control;
  delete bare.candidates[0].control_exit_code;
  assert.match(problems(bare).join("\n"), /no discrimination receipt/);

  const probed = confirmed({
    candidates: [
      {
        ...confirmed().candidates[0],
        control: undefined,
        control_exit_code: undefined,
        probe: "py neuter inserted before app.py:6",
        probe_exit_code: 1,
        probe_flipped: "yes",
      },
    ],
  });
  assert.deepEqual(problems(probed), [], "a flipped probe is a receipt on its own");

  const vacuous = confirmed({
    candidates: [{ ...confirmed().candidates[0], verdict: "inconclusive_vacuous" }],
  });
  assert.match(problems(vacuous).join("\n"), /inconclusive_vacuous" requires probe_flipped "no"/);
});

for (const predicted of ["pass", "fail"]) {
  test(`a held ${predicted} prediction with a non-flip is storable only as inconclusive_vacuous`, () => {
    const c = confirmed({
      status: "unverified",
      confirmed_cause: null,
      confidence: "low",
      leading_hypothesis: "not yet isolated",
    });
    Object.assign(c.candidates[0], {
      predicted,
      check_exit_code: predicted === "pass" ? 0 : 1,
      verdict: "inconclusive_vacuous",
      probe_flipped: "no",
    });
    assert.deepEqual(problems(c), []);
    c.candidates[0].check_exit_code = predicted === "pass" ? 1 : 0;
    assert.match(problems(c).join("\n"), /contradicts its own check/);
    c.candidates[0].check_exit_code = predicted === "pass" ? 0 : 1;
    c.candidates[0].verdict = "confirmed";
    assert.match(problems(c).join("\n"), /probe_flipped.*no|non-flip/);
  });
}

test("a pass prediction needs a flipped probe even with a passed control", () => {
  const c = confirmed();
  Object.assign(c.candidates[0], { predicted: "pass", check_exit_code: 0 });
  assert.match(problems(c).join("\n"), /pass.*flipped probe/);
  c.candidates[0].probe_flipped = "yes";
  assert.deepEqual(problems(c), []);
});

test("speculation is refused: a verdict with no evidence cannot be recorded", () => {
  const c = confirmed();
  c.candidates[0].evidence = "";
  assert.match(problems(c).join("\n"), /no captured output/);
});

test("a verdict typed by hand, with no executed check behind it, is refused", () => {
  const typed = confirmed();
  delete typed.candidates[0].predicted;
  delete typed.candidates[0].check_exit_code;
  assert.match(
    problems(typed).join("\n"),
    /has no "predicted" oracle — record it with run_check\.mjs/,
  );
  const contradicted = confirmed({
    candidates: [{ ...confirmed().candidates[0], predicted: "pass", check_exit_code: 1 }],
  });
  assert.match(
    problems(contradicted).join("\n"),
    /contradicts its own check \(predicted pass, exit 1 ⇒ falsified\)/,
  );
});

test("a non-reproducing case that keeps guessing is refused", () => {
  const c = confirmed();
  c.reproduction.outcome = "does_not_reproduce";
  const joined = problems(c).join("\n");
  assert.match(joined, /must stop with zero candidates/);
  assert.match(joined, /requires outcome "reproduced"/);
});

test("an honest unverified case is accepted; an unlabelled one is not", () => {
  const c = confirmed({ status: "unverified", confirmed_cause: null, confidence: "low" });
  c.candidates[0].verdict = "inconclusive";
  assert.match(problems(c).join("\n"), /needs leading_hypothesis/);
  c.leading_hypothesis = "end bound is off by one, but no check isolated it yet";
  assert.deepEqual(problems(c), []);
});

test("a patch before a confirmed cause is refused", () => {
  const c = confirmed({ status: "open", confirmed_cause: null });
  c.suggested_patch = "- end = len(rows) - 1\n+ end = len(rows)";
  assert.match(problems(c).join("\n"), /requires status "confirmed"/);
});

test("the candidate cap from SKILL.md is enforced by the schema", () => {
  const c = confirmed();
  c.candidates = Array.from({ length: 6 }, (_, i) => ({ ...c.candidates[0], rank: i + 1 }));
  assert.match(problems(c).join("\n"), /exceeds the cap of 5/);
});

test("an empty symptom is not a case", () => {
  assert.match(problems(confirmed({ symptom: "  " })).join("\n"), /symptom is empty/);
});

/**
 * `id` names files: `.ducktective/cases/<id>.md`, and run_check writes and runs
 * `ducktective-check-<id>-<rank>.<ext>` at the repo root. `^DT-` alone accepted
 * `DT-../../pwned`, which wrote outside `cases/`, and `DT-../../../tmp/evil`,
 * which escaped the repo entirely.
 */
test("an id cannot be used to write outside the store", () => {
  for (const evil of [
    "DT-../../pwned",
    "DT-..%2f..%2fpwned",
    "DT-../../x/../../escaped",
    String.raw`DT-..\..\..\escaped`,
    "DT-\0",
    "DT-",
    "DT-" + "a".repeat(80),
    "XN-260101-ab12",
  ]) {
    assert.match(
      validateSchema(confirmed({ id: evil }), SCHEMA).join("\n"),
      /does not match/,
      `schema accepted an unsafe id: ${JSON.stringify(evil)}`,
    );
  }
  // The guard holds even when a caller skips validation, because writeCase is
  // the last thing standing between a draft and the filesystem.
  assert.throws(() => writeCase({ ...confirmed(), id: "DT-../../pwned" }, repoless), /unsafe id/);
  assert.doesNotThrow(() =>
    writeCase({ ...confirmed(), id: "DT-260101-ab12" }, mkdtempSync(join(tmpdir(), "dt-id-"))),
  );
});
const repoless = mkdtempSync(join(tmpdir(), "dt-id-"));

test("strong confidence and a stated cause only travel with a confirmed status", () => {
  const open = confirmed({ status: "open", confirmed_cause: null });
  assert.match(problems(open).join("\n"), /confidence "high" requires status "confirmed"/);
  const cause = confirmed({ status: "unverified", confidence: "low" });
  assert.match(problems(cause).join("\n"), /confirmed_cause requires status "confirmed"/);
});

test("a misspelled field is a validation error, not an undefined read later", () => {
  assert.match(
    problems(confirmed({ confidance: "high" })).join("\n"),
    /unknown property "confidance"/,
  );
  const cand = confirmed();
  cand.candidates[0].hyposis = "oops";
  assert.match(problems(cand).join("\n"), /unknown property "hyposis"/);
  const site = confirmed();
  site.reproduction.covered = [{ file: "app.py", line: "7" }];
  assert.match(problems(site).join("\n"), /covered\[0\]\.line: expected number, got string/);
});

test("evidence clips keep both ends, because the traceback tail is the finding", () => {
  const long = "HEAD\n" + "x".repeat(5000) + "\nIndexError: list index out of range";
  const out = clip(long, 400);
  assert.ok(out.length < long.length);
  assert.match(out, /^HEAD/);
  assert.match(out, /IndexError: list index out of range$/);
  assert.match(out, /chars elided/);
});
