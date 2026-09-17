/**
 * run_check: the oracle arithmetic, the sequence policy, and the dry-run gate.
 *
 * Every check here is a `node -e` one-liner, so the tests need neither python
 * nor a model — the tool's job is to execute and judge, and that is what is
 * under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blockers, classify, materialize, pickCandidate, probe } from "../scripts/run_check.mjs";
import { SCHEMA, policyViolations, validateSchema } from "../scripts/lib/case-file.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "scripts", "run_check.mjs");

const DRAFT = () => ({
  id: "DT-260101-0aa1bb",
  opened_at: "2026-01-01T00:00:00.000Z",
  symptom: "totals drop the last row",
  reproduction: {
    command: "python -m unittest -q",
    outcome: "reproduced",
    exit_code: 1,
    duration_ms: 200,
  },
  candidates: [
    {
      rank: 1,
      location: "app.py:7 total()",
      why: "appears in the failing traceback",
      hypothesis: "rows[end + 1] indexes past the end when end defaults to len(rows) - 1",
      check: 'node -e "process.exit(1)"',
      verdict: "pending",
      evidence: "",
    },
    {
      rank: 2,
      location: "test_totals.py:10 test_sums_every_row()",
      why: "appears in the failing traceback",
      hypothesis: "the test passes wrong arguments",
      check: 'node -e "process.exit(1)"',
      verdict: "pending",
      evidence: "",
    },
  ],
  confirmed_cause: null,
  leading_hypothesis: null,
  confidence: "none",
  suggested_patch: null,
  status: "open",
  notes: "",
});

/** A scratch repo holding the draft; `repo` doubles as --cwd. */
function withDraft(t, draft = DRAFT()) {
  const repo = mkdtempSync(join(tmpdir(), "dt-run-"));
  const file = join(repo, "draft.json");
  writeFileSync(file, JSON.stringify(draft, null, 2), "utf8");
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  return { repo, file, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

/**
 * A passing control on every call, so the tests about sequencing, depth and re-runs
 * are not all blocked by the receipt rule. `--no-receipt` opts one call out of it
 * (and never reaches the tool) for the tests that are about the receipt itself.
 */
const CTL = ["--control", 'node -e "process.exit(0)"'];

function tool(args, cwd) {
  if (args.includes("--predict") && !args.includes("--control") && !args.includes("--verify")) {
    const noReceipt = args.indexOf("--no-receipt");
    args = noReceipt >= 0 ? args.filter((a) => a !== "--no-receipt") : [...args, ...CTL];
  }
  const run = spawnSync(process.execPath, [TOOL, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  let out = null;
  try {
    out = JSON.parse(run.stdout);
  } catch {
    if (run.stdout.trim())
      throw new Error(
        `bad stdout: ${run.stdout.slice(0, 300)}\nstderr: ${run.stderr.slice(0, 300)}`,
      );
  }
  return { code: run.status, out, stderr: run.stderr, stdout: run.stdout };
}

const decided = (draft, rank) => draft.candidates.find((c) => c.rank === rank);

// --- dry run: the human reads the command before anything executes ---------

test("nothing executes without --yes, and the draft is untouched", (t) => {
  const d = withDraft(t);
  const check = `node -e "require('fs').writeFileSync('ran.txt','x')"`;
  const before = readFileSync(d.file, "utf8");
  const { code, stderr } = tool(
    ["--file", d.file, "--candidate", "1", "--predict", "fail", "--cmd", check],
    d.repo,
  );
  assert.equal(code, 3, "dry run must be distinguishable from a verdict");
  assert.match(stderr, /DRY RUN — nothing executed/);
  assert.ok(stderr.includes(check), "the exact command must be printed for review");
  assert.ok(!existsSync(join(d.repo, "ran.txt")), "the check must not have run");
  assert.equal(readFileSync(d.file, "utf8"), before, "a dry run must not mutate the draft");
});

test("multi-line dry runs display source without creating or overwriting a script", (t) => {
  const d = withDraft(t);
  const script = "console.log('review this source');\nprocess.exit(1);\n";
  const path = join(d.repo, "ducktective-check-DT-260101-0aa1bb-1.mjs");
  for (const existing of [false, true]) {
    if (existing) writeFileSync(path, "user-owned contents");
    const before = readFileSync(d.file, "utf8");
    const result = tool(
      [
        "--file",
        d.file,
        "--candidate",
        "1",
        "--predict",
        "fail",
        "--cmd",
        script,
        "--lang",
        "js",
        "--keep",
      ],
      d.repo,
    );
    assert.equal(result.code, 3, result.stderr);
    assert.ok(result.stderr.includes(script.trim()), "review includes the script source");
    assert.equal(readFileSync(d.file, "utf8"), before);
    if (existing) assert.equal(readFileSync(path, "utf8"), "user-owned contents");
    else assert.equal(existsSync(path), false);
  }
});

test("--verify refuses a replacement command before executing or changing the draft", (t) => {
  const d = withDraft(t);
  tool(["--file", d.file, "--candidate", "1", "--predict", "fail", "--yes"], d.repo);
  const before = readFileSync(d.file, "utf8");
  const result = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--verify",
      "--yes",
      "--cmd",
      `node -e "require('fs').writeFileSync('replacement-ran','');process.exit(1)"`,
    ],
    d.repo,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--verify.*recorded check|--cmd/);
  assert.equal(existsSync(join(d.repo, "replacement-ran")), false);
  assert.equal(readFileSync(d.file, "utf8"), before);
});

// --- the arithmetic ---------------------------------------------------------

for (const [predict, exit, want] of [
  ["fail", 1, "confirmed"],
  ["fail", 0, "falsified"],
  ["pass", 0, "inconclusive"],
  ["pass", 1, "falsified"],
]) {
  test(`--predict ${predict} with exit ${exit} is ${want}`, (t) => {
    const d = withDraft(t);
    const { code, out } = tool(
      [
        "--file",
        d.file,
        "--candidate",
        "1",
        "--predict",
        predict,
        "--cmd",
        `node -e "process.exit(${exit})"`,
        "--yes",
      ],
      d.repo,
    );
    assert.equal(code, want === "inconclusive" ? 2 : 0);
    assert.equal(out.verdict, want);
    assert.equal(decided(d.read(), 1).verdict, want);
    assert.equal(decided(d.read(), 1).predicted, predict);
    assert.equal(decided(d.read(), 1).check_exit_code, exit);
  });
}

test("the recorded evidence is what the process actually printed", (t) => {
  const d = withDraft(t);
  tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "fail",
      "--cmd",
      "node -e \"console.log('bounded end -> 7'); process.exit(1)\"",
      "--yes",
    ],
    d.repo,
  );
  const cand = decided(d.read(), 1);
  assert.match(cand.evidence, /check: exit 1 in \d+ ms/);
  assert.match(cand.evidence, /bounded end -> 7/);
});

test("a control that also fails makes the check no oracle at all (rule 5)", (t) => {
  const d = withDraft(t);
  const { code, out } = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "fail",
      "--cmd",
      'node -e "process.exit(1)"',
      "--control",
      'node -e "process.exit(1)"',
      "--yes",
    ],
    d.repo,
  );
  assert.equal(code, 2, "an unevaluable oracle must not look like a verdict");
  assert.equal(out.verdict, "inconclusive");
  const cand = decided(d.read(), 1);
  assert.match(cand.evidence, /control also failed/);
  assert.equal(cand.control_exit_code, 1);
  // An inconclusive oracle is still storable, as long as it is labelled.
  const labelled = {
    ...d.read(),
    status: "unverified",
    leading_hypothesis: "off-by-one on the default end",
  };
  assert.deepEqual(
    [...validateSchema(labelled, SCHEMA), ...policyViolations(labelled)].filter((p) =>
      /inconclusive/.test(p),
    ),
    [],
  );
});

test("a check that cannot be run is inconclusive, never a falsification", (t) => {
  const d = withDraft(t);
  const { code, out } = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "fail",
      "--cmd",
      "ducktective-no-such-binary",
      "--yes",
    ],
    d.repo,
  );
  assert.equal(code, 2);
  assert.equal(out.verdict, "inconclusive");
  assert.match(decided(d.read(), 1).evidence, /could not be run/);
});

// --- the sequence policy ----------------------------------------------------

test("a candidate with no hypothesis cannot be tested", (t) => {
  const draft = DRAFT();
  draft.candidates[0].hypothesis = "";
  const d = withDraft(t, draft);
  const { code, stderr } = tool(
    ["--file", d.file, "--candidate", "1", "--predict", "fail", "--yes"],
    d.repo,
  );
  assert.equal(code, 1);
  assert.match(stderr, /no hypothesis/);
});

test("escalating past a pending candidate is refused", (t) => {
  const d = withDraft(t);
  const { code, stderr } = tool(
    ["--file", d.file, "--candidate", "2", "--predict", "pass", "--yes"],
    d.repo,
  );
  assert.equal(code, 1);
  assert.match(stderr, /candidate 1 .* still has no verdict/);
  assert.match(stderr, /one candidate hard/);
});

test("a FALSIFIED lead opens the next one; a confirmed one closes the case", (t) => {
  const d = withDraft(t);
  // candidate 1's check exits 0 while the hypothesis predicted failure → falsified
  const first = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "fail",
      "--cmd",
      'node -e "process.exit(0)"',
      "--yes",
    ],
    d.repo,
  );
  assert.equal(first.out.verdict, "falsified");
  const second = tool(["--file", d.file, "--candidate", "2", "--predict", "fail", "--yes"], d.repo);
  assert.equal(second.code, 0, "demoting a wrong lead is not the same as finding the cause");
  assert.equal(second.out.verdict, "confirmed");
});

test("--hypothesis states the claim in the same breath as the check", (t) => {
  const draft = DRAFT();
  draft.candidates[0].hypothesis = "";
  const d = withDraft(t, draft);
  const missing = tool(
    ["--file", d.file, "--candidate", "1", "--predict", "fail", "--yes"],
    d.repo,
  );
  assert.equal(missing.code, 1, "no claim, nothing to test");
  const { code } = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--hypothesis",
      "end + 1 walks off the list",
      "--predict",
      "fail",
      "--cmd",
      'node -e "process.exit(1)"',
      "--yes",
    ],
    d.repo,
  );
  assert.equal(code, 0);
  const cand = decided(d.read(), 1);
  assert.equal(cand.hypothesis, "end + 1 walks off the list");
  assert.equal(cand.verdict, "confirmed");
});

test("a draft with an unsafe id is refused before anything is written", (t) => {
  const draft = DRAFT();
  draft.id = "DT-../../escape";
  const d = withDraft(t, draft);
  const { code, stderr } = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--hypothesis",
      "past the end",
      "--predict",
      "fail",
      "--lang",
      "js",
      "--cmd",
      "console.log(1)\n",
      "--yes",
    ],
    d.repo,
  );
  assert.equal(code, 1, "run_check must not build a path from an id it never validated");
  assert.match(stderr, /REFUSED|unsafe|does not match/);
  assert.equal(existsSync(join(d.repo, "..", "..", "escape-1.py")), false);
  assert.deepEqual(
    readdirSync(d.repo).sort(),
    ["draft.json"],
    "refusal must leave the repo untouched",
  );
});

test("a confirmed cause stops the investigation — the doc's step 3 is 'Stop'", (t) => {
  const d = withDraft(t);
  assert.equal(
    tool(["--file", d.file, "--candidate", "1", "--predict", "fail", "--yes"], d.repo).out.verdict,
    "confirmed",
  );
  const after = tool(["--file", d.file, "--candidate", "2", "--predict", "pass", "--yes"], d.repo);
  assert.equal(
    after.code,
    1,
    "testing past a confirmed cause is the scattergun the design doc forbids",
  );
  assert.match(after.stderr, /CONFIRMED cause/);
  assert.match(after.stderr, /--escalate/);
  // The answer is in the file: it must be storable exactly as it stands.
  const done = d.read();
  assert.deepEqual(
    [
      ...validateSchema(done, SCHEMA),
      ...policyViolations({
        ...done,
        status: "unverified",
        leading_hypothesis: "x",
        confirmed_cause: null,
        confidence: "low",
      }),
    ].filter((x) => /CONFIRMED cause/.test(x)),
    [],
  );
  const deliberate = tool(
    ["--file", d.file, "--candidate", "2", "--predict", "pass", "--escalate", "--yes"],
    d.repo,
  );
  assert.equal(deliberate.code, 0, "--escalate means a second fault is being chased on purpose");
});

test("an inconclusive check does not unlock the next candidate", (t) => {
  const d = withDraft(t);
  // candidate 1: unrunnable check → inconclusive, which is not an answer
  const first = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "fail",
      "--cmd",
      "ducktective-no-such-binary",
      "--yes",
    ],
    d.repo,
  );
  assert.equal(first.out.verdict, "inconclusive");
  const second = tool(["--file", d.file, "--candidate", "2", "--predict", "pass", "--yes"], d.repo);
  assert.equal(second.code, 1, "a lead that was never tested must not count as tried hard");
  assert.match(second.stderr, /inconclusive/);
  assert.match(second.stderr, /--escalate/);
  const forced = tool(
    ["--file", d.file, "--candidate", "2", "--predict", "pass", "--escalate", "--yes"],
    d.repo,
  );
  assert.equal(forced.code, 0, "--escalate moves past it knowingly, and says so in the case file");
});

test("a decided candidate is not re-run unless asked", (t) => {
  const d = withDraft(t);
  tool(["--file", d.file, "--candidate", "1", "--predict", "fail", "--yes"], d.repo);
  const again = tool(["--file", d.file, "--candidate", "1", "--predict", "fail", "--yes"], d.repo);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already has verdict "confirmed"/);
  assert.equal(
    tool(["--file", d.file, "--candidate", "1", "--predict", "pass", "--rerun", "--yes"], d.repo)
      .code,
    0,
  );
});

test("a draft whose gate said stop cannot be investigated further", (t) => {
  const draft = DRAFT();
  draft.reproduction.outcome = "does_not_reproduce";
  draft.candidates = [];
  const d = withDraft(t, draft);
  const { code, stderr } = tool(
    ["--file", d.file, "--candidate", "1", "--predict", "fail", "--yes"],
    d.repo,
  );
  assert.equal(code, 2, "there is no candidate 1 to pick");
  assert.match(stderr, /not one of the seeded leads/);
});

test("an ambiguous location is refused rather than guessed", (t) => {
  const d = withDraft(t);
  // "total" is inside both seeded leads, so picking one would be a coin flip.
  const { code, stderr } = tool(
    ["--file", d.file, "--candidate", "total", "--predict", "fail", "--yes"],
    d.repo,
  );
  assert.equal(code, 2);
  assert.match(stderr, /not one of the seeded leads/);
});

// --- multi-line checks ------------------------------------------------------

test("a multi-line check becomes a script that is recorded, replayable, and cleaned up", (t) => {
  const d = withDraft(t);
  const script = 'import { total } from "./app.mjs";\nconsole.log("got", total([1, 2, 3, 4]));\n';
  writeFileSync(
    join(d.repo, "app.mjs"),
    "export const total = (r) => r.slice(0, r.length - 1).reduce((a, b) => a + b, 0);\n",
  );
  const { code, out } = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "fail",
      "--lang",
      "js",
      "--cmd",
      script,
      "--yes",
    ],
    d.repo,
  );
  assert.equal(code, 0);
  assert.equal(
    out.verdict,
    "falsified",
    "the script printed and exited 0, so the fail-prediction did not hold",
  );
  const cand = decided(d.read(), 1);
  assert.match(cand.check, /ducktective-check-DT-260101-0aa1bb-1\.mjs/);
  assert.match(cand.check, /import \{ total \}/);
  assert.match(
    cand.evidence,
    /got 6/,
    "the script must import from the repo, not from its own folder",
  );
  assert.ok(
    !existsSync(join(d.repo, "ducktective-check-DT-260101-0aa1bb-1.mjs")),
    "the scratch script must be gone",
  );
});

test("--keep leaves the materialized script for the human to rerun", (t) => {
  const d = withDraft(t);
  const script = 'console.log("kept");\n';
  const { code } = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "fail",
      "--lang",
      "js",
      "--cmd",
      script,
      "--keep",
      "--yes",
    ],
    d.repo,
  );
  assert.equal(code, 0);
  assert.ok(existsSync(join(d.repo, "ducktective-check-DT-260101-0aa1bb-1.mjs")));
});

test("a multi-line check with no language is refused, not guessed", (t) => {
  const d = withDraft(t);
  const { code, stderr } = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "fail",
      "--cmd",
      "print('hi')\nassert 1 == 2\n",
      "--yes",
    ],
    d.repo,
  );
  assert.equal(code, 1);
  assert.match(stderr, /check is multi-line/);
});

// --- the unit pieces --------------------------------------------------------

// --- --depth: the doc's speed control, L131 ---------------------------------

test("--depth 1 forbids escalation entirely, even after a clean falsification", (t) => {
  const d = withDraft(t);
  tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "fail",
      "--cmd",
      'node -e "process.exit(0)"',
      "--yes",
    ],
    d.repo,
  );
  const blocked = tool(
    ["--file", d.file, "--candidate", "2", "--predict", "pass", "--depth", "1", "--yes"],
    d.repo,
  );
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /past --depth 1/);
  const allowed = tool(
    ["--file", d.file, "--candidate", "2", "--predict", "pass", "--depth", "2", "--yes"],
    d.repo,
  );
  assert.equal(allowed.code, 0);
  assert.equal(
    tool(
      ["--file", d.file, "--candidate", "1", "--predict", "fail", "--depth", "0", "--yes"],
      d.repo,
    ).code,
    2,
    "--depth 0 is nonsense, not 'no candidates'",
  );
});

// --- --verify: success metric #2, "survive a second independent run" --------

test("--verify re-executes the recorded oracle and says whether the claim survived", (t) => {
  const d = withDraft(t);
  const first = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "fail",
      "--cmd",
      'node -e "process.exit(1)"',
      "--yes",
    ],
    d.repo,
  );
  assert.equal(first.out.verdict, "confirmed");
  const { code, out } = tool(["--file", d.file, "--candidate", "1", "--verify", "--yes"], d.repo);
  assert.equal(code, 0, "a claim that survives is the good outcome");
  assert.equal(out.survived, true);
  assert.equal(out.verify_verdict, "confirmed");
  assert.match(
    out.caveat,
    /same machine and working tree/,
    "the limit of a second run here is stated, not glossed",
  );
  const cand = decided(d.read(), 1);
  assert.equal(cand.verified_verdict, "confirmed");
  assert.equal(cand.verified_exit_code, 1);
  assert.deepEqual(
    [
      ...validateSchema(d.read(), SCHEMA),
      ...policyViolations({
        ...d.read(),
        status: "confirmed",
        confirmed_cause: "x",
        confidence: "high",
      }),
    ],
    [],
  );
});

test("--verify catches a flaky oracle, and the case file cannot be filed anyway", (t) => {
  const d = withDraft(t);
  // exits 1 the first time it runs, 0 on every run after: a confounding second
  // run is exactly what the metric is for
  const flip =
    "node -e \"const f=require('node:fs');const k='flip';const n=f.existsSync(k)?0:1;f.writeFileSync(k,'');process.exit(n)\"";
  assert.equal(
    tool(
      ["--file", d.file, "--candidate", "1", "--predict", "fail", "--cmd", flip, "--yes"],
      d.repo,
    ).out.verdict,
    "confirmed",
  );
  const { code, out } = tool(["--file", d.file, "--candidate", "1", "--verify", "--yes"], d.repo);
  assert.equal(code, 2, "a claim that fell over is a finding, not a success");
  assert.equal(out.survived, false);
  assert.equal(out.verify_verdict, "falsified");
  const stored = d.read();
  const cand = decided(stored, 1);
  assert.equal(
    cand.verdict,
    "confirmed",
    "--verify must not rewrite the claim, only record the re-test",
  );
  const filed = {
    ...stored,
    status: "confirmed",
    confirmed_cause: "one past the end",
    confidence: "high",
  };
  assert.match(policyViolations(filed).join("\n"), /did not survive re-execution/);
});

test("--verify needs something to verify and never a fresh prediction", (t) => {
  const d = withDraft(t);
  const pending = tool(["--file", d.file, "--candidate", "1", "--verify", "--yes"], d.repo);
  assert.equal(pending.code, 1);
  assert.match(pending.stderr, /no executed oracle to re-test/);
  tool(["--file", d.file, "--candidate", "1", "--predict", "fail", "--yes"], d.repo);
  assert.equal(
    tool(["--file", d.file, "--candidate", "1", "--verify", "--predict", "pass", "--yes"], d.repo)
      .code,
    2,
    "a second guess cannot move the answer",
  );
});

test("pickCandidate finds by rank or unique substring only", () => {
  const cs = DRAFT().candidates;
  assert.equal(pickCandidate(cs, 2).cand.location, cs[1].location);
  assert.equal(pickCandidate(cs, "test_totals").cand.rank, 2);
  assert.equal(pickCandidate(cs, "app.py").cand.rank, 1, "a unique substring resolves");
  assert.equal(pickCandidate(cs, "total"), null, "a substring inside both leads must not resolve");
  assert.equal(pickCandidate(cs, 9), null);
});

test("blockers lists every unfinished lead ahead of the chosen one", () => {
  const cs = DRAFT().candidates;
  assert.equal(blockers(cs, 0).length, 0);
  assert.match(blockers(cs, 1).join(" "), /candidate 1/);
  cs[0].verdict = "falsified";
  assert.deepEqual(blockers(cs, 1), []);
});

test("materialize sniffs a shebang and leaves single lines alone", (t) => {
  const d = withDraft(t);
  const one = materialize("pytest -q", { repo: d.repo, caseId: "DT-1", rank: 1 });
  assert.deepEqual(one, { command: "pytest -q", file: null });
  const two = materialize("#!/usr/bin/env python\nprint(1)\n", {
    repo: d.repo,
    caseId: "DT-1",
    rank: 2,
  });
  assert.match(two.command, /^"python" ".+ducktective-check-DT-1-2\.py"$/);
  assert.equal(dirname(two.file), d.repo, "the script must sit where it can import the repo");
  assert.equal(readFileSync(two.file, "utf8"), "#!/usr/bin/env python\nprint(1)\n");
  assert.throws(
    () => materialize("print(1)\nprint(2)\n", { repo: d.repo, caseId: "DT-1", rank: 3 }),
    /multi-line/,
  );
});

test("--verify can re-execute the check it recorded", (t) => {
  // The recording writes the runner command above the source so a human can see
  // what ran. Re-running that field verbatim made the command the script's first
  // line: every multi-line check died with a SyntaxError, and M3 — "did the claim
  // survive a second run" — could not be computed for the common case at all.
  const d = withDraft(t, {
    ...DRAFT(),
    candidates: [
      {
        rank: 1,
        location: "app.py:7 total()",
        why: "appears in the failing traceback",
        hypothesis: "the last row is dropped when end defaults to len(rows) - 1",
        check: "#!/usr/bin/env node\nconsole.log('the oracle ran')\nprocess.exit(1)\n",
        verdict: "pending",
        evidence: "",
      },
    ],
  });
  const first = tool(
    ["--file", d.file, "--candidate", "1", "--predict", "fail", "--lang", "js", "--yes"],
    d.repo,
  );
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.out.verdict, "confirmed");
  const again = tool(["--file", d.file, "--candidate", "1", "--verify", "--yes"], d.repo);
  assert.equal(again.code, 0, `--verify refused: ${again.stderr}`);
  assert.equal(again.out.survived, true, JSON.stringify(again.out));
  const cand = decided(d.read(), 1);
  assert.equal(cand.verified_verdict, "confirmed");
  assert.equal(
    cand.check.split("# script written to the repo root").length - 1,
    1,
    "a re-run must not stack a second recorded command line onto the check",
  );
});

test("a python check runs under the repo's own venv, not the machine's python", (t) => {
  // Global `python` here has no numpy and no pytest. It exited 1 on
  // ModuleNotFoundError and the tool filed that as `falsified` — a hypothesis
  // that was never tested, recorded as a disproved one.
  const d = withDraft(t);
  const rel =
    process.platform === "win32"
      ? join(".venv", "Scripts", "python.exe")
      : join(".venv", "bin", "python");
  mkdirSync(join(d.repo, dirname(rel)), { recursive: true });
  writeFileSync(join(d.repo, rel), "", "utf8");
  const { command } = materialize("#!/usr/bin/env python\nprint(1)\n", {
    repo: d.repo,
    caseId: "DT-1",
    rank: 1,
  });
  assert.ok(command.includes(join(d.repo, rel)), `expected the repo interpreter in: ${command}`);
  const bare = materialize("#!/usr/bin/env python\nprint(1)\n", {
    repo: mkdtempSync(join(tmpdir(), "dt-novenv-")),
    caseId: "DT-1",
    rank: 1,
  });
  assert.match(bare.command, /^"python" /, "no venv, no opinion");
});

// --- the probe: does the check depend on the line it accuses? ---------------

const LIB = `export function total(rows) {
  let sum = 0;
  for (const r of rows) sum += r;
  return sum;
}
export const unused = "nothing imports this";
`;

/** The check passes when line 3 does its work. */
const DEPENDS =
  "node -e \"import('./src/lib.mjs').then((m)=>process.exit(m.total([1,2,3])===6?0:1))\"";
/** The check fails when line 3 does its work — same exit code, different reason. */
const INVERTED =
  "node -e \"import('./src/lib.mjs').then((m)=>process.exit(m.total([1,2,3])===6?1:0))\"";

function gitSandbox(t, { location, check }) {
  const repo = mkdtempSync(join(tmpdir(), "dt-probe-"));
  const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8", windowsHide: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/lib.mjs"), LIB, "utf8");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "tests@example.invalid");
  git("config", "user.name", "tests");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const file = join(repo, "draft.json");
  const draft = DRAFT();
  draft.candidates = [{ ...draft.candidates[0], location, check, evidence: "x" }];
  writeFileSync(file, JSON.stringify(draft, null, 2), "utf8");
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  return { repo, file, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

const probeRun = (d, predict) =>
  tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      predict,
      "--probe",
      "--no-receipt",
      "--yes",
    ],
    d.repo,
  );

test("--probe: a flipped check is the receipt that confirms it", (t) => {
  const d = gitSandbox(t, { location: "src/lib.mjs:3 total()", check: DEPENDS });
  const { code, out, stderr } = probeRun(d, "pass");
  assert.equal(code, 0, stderr);
  assert.equal(out.verdict, "confirmed", "deleting the loop changed the outcome");
  assert.equal(out.probe_flipped, "yes");
  const cand = decided(d.read(), 1);
  assert.equal(cand.probe_flipped, "yes");
  assert.match(cand.probe, /src\/lib\.mjs:3 commented out/);
  assert.ok(!existsSync(join(d.repo, "src", "lib.mjs.bak")), "the tree is never touched");
  assert.equal(
    readFileSync(join(d.repo, "src", "lib.mjs"), "utf8"),
    LIB,
    "the user's file must come back byte-identical",
  );
});

test("--probe: a check that ignores the line is inconclusive_vacuous, not confirmed", (t) => {
  const d = gitSandbox(t, { location: "src/lib.mjs:6 unused", check: DEPENDS });
  const { code, out, stderr } = probeRun(d, "pass");
  assert.equal(code, 2, "a vacuous oracle is a harness-level result: " + stderr);
  assert.equal(out.verdict, "inconclusive_vacuous");
  assert.equal(d.read().candidates[0].probe_flipped, "no");
  assert.match(
    d.read().candidates[0].evidence,
    /did not change when the accused line was neutered/,
  );
});

test("--probe: a neuter that breaks the run is reported, not scored", (t) => {
  // Line 2 initialises `sum`; deleting it raises ReferenceError inside the same
  // failing exit code. "Crashed differently" is not "behaved the same" — calling
  // that vacuous would file a wrong finding with confidence.
  const d = gitSandbox(t, { location: "src/lib.mjs:2 total()", check: INVERTED });
  const { code, out, stderr } = probeRun(d, "fail");
  assert.equal(code, 2, stderr);
  assert.equal(out.verdict, "inconclusive");
  assert.equal(d.read().candidates[0].probe_flipped, "not-run");
  assert.match(d.read().candidates[0].probe, /not comparable|broke the program/);
});

test("a check that needs an untracked dependency cannot be probed", (t) => {
  // The scratch worktree is checked out from HEAD, so it has no `.venv`, no
  // `node_modules`, no generated files. Reproduced against a real repo on
  // 2026-09-15: the check ran green in the tree and red in the worktree, and the
  // first version of the probe read that as "the line does not matter".
  // The check passes only because dep.mjs is in the working tree; a worktree
  // checked out from HEAD has never heard of it, so the probe learns nothing
  // about the accused line and must say so rather than call the check vacuous.
  const d = gitSandbox(t, {
    location: "src/lib.mjs:3 total()",
    check: `node -e "import('./dep.mjs').then(()=>process.exit(0),()=>process.exit(1))"`,
  });
  writeFileSync(join(d.repo, "dep.mjs"), "export default 1;", "utf8");
  const { code, out } = probeRun(d, "pass");
  assert.equal(code, 2, "an unlearnable probe is inconclusive, not vacuous");
  assert.equal(out.verdict, "inconclusive");
  assert.equal(d.read().candidates[0].probe_flipped, "not-run");
});

for (const line of [1, 2]) {
  test(`--probe: passing baseline followed by parse/name crash at line ${line} is not a flip`, (t) => {
    const d = gitSandbox(t, { location: `src/lib.mjs:${line} total()`, check: DEPENDS });
    const result = probeRun(d, "pass");
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.out.verdict, "inconclusive");
    assert.equal(result.out.probe_flipped, "not-run");
    assert.match(d.read().candidates[0].probe, /not comparable/);
  });
}

test("--probe: py sole body line falls through to neutralize and flips", (t) => {
  // The C7 blocker: deleting the only body line of an indented Python block
  // yields IndentationError — an artifact, not a comparable run. The neutralize
  // strategy (same-indentation `pass`) keeps the program running, so a check
  // that depends on that line flips instead of reporting not-run.
  const pyRepo = mkdtempSync(join(tmpdir(), "dt-probe-py-"));
  const git = (...a) => spawnSync("git", a, { cwd: pyRepo, encoding: "utf8", windowsHide: true });
  mkdirSync(join(pyRepo, "src"), { recursive: true });
  writeFileSync(join(pyRepo, "src/calc.py"), "def total(rows):\n    return sum(rows)\n", "utf8");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "tests@example.invalid");
  git("config", "user.name", "tests");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const file = join(pyRepo, "draft.json");
  const draft = DRAFT();
  draft.candidates = [
    {
      ...draft.candidates[0],
      location: "src/calc.py:2 total()",
      check:
        "python -c \"import sys; sys.path.insert(0, 'src'); from calc import total; sys.exit(0 if total([1,2,3]) == 6 else 1)\"",
      evidence: "x",
    },
  ];
  writeFileSync(file, JSON.stringify(draft, null, 2), "utf8");
  t.after(() => {
    rmSync(pyRepo, { recursive: true, force: true });
  });
  const { code, out, stderr } = probeRun(
    { repo: pyRepo, file, read: () => JSON.parse(readFileSync(file, "utf8")) },
    "pass",
  );
  assert.equal(code, 0, stderr);
  assert.equal(
    out.verdict,
    "confirmed",
    "the line is the only body line; neutralizing it must flip",
  );
  assert.equal(out.probe_flipped, "yes");
  assert.match(
    String(readFileSync(file, "utf8")),
    /neutralize/,
    "the strategy that flipped is recorded",
  );
  assert.equal(
    readFileSync(join(pyRepo, "src", "calc.py"), "utf8"),
    "def total(rows):\n    return sum(rows)\n",
    "the user's file must come back byte-identical",
  );
});

test("--probe: all strategies unusable reports not-run, never vacuous", (t) => {
  // Python, multi-line function, accused line = the `def` itself: delete
  // orphans the indented body (IndentationError), neutralize turns the def
  // into `pass` while the body below stays indented (also IndentationError).
  // No comparable mutant exists — "could not test" must stay distinct from
  // "ran and did not care" (vacuous).
  const pyRepo = mkdtempSync(join(tmpdir(), "dt-probe-py2-"));
  const git = (...a) => spawnSync("git", a, { cwd: pyRepo, encoding: "utf8", windowsHide: true });
  mkdirSync(join(pyRepo, "src"), { recursive: true });
  writeFileSync(
    join(pyRepo, "src/calc.py"),
    "def total(rows):\n    s = 0\n    for r in rows:\n        s += r\n    return s\n",
    "utf8",
  );
  git("init", "-q", "-b", "main");
  git("config", "user.email", "tests@example.invalid");
  git("config", "user.name", "tests");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const file = join(pyRepo, "draft.json");
  const draft = DRAFT();
  draft.candidates = [
    {
      ...draft.candidates[0],
      location: "src/calc.py:1 total()",
      check:
        "python -c \"import sys; sys.path.insert(0, 'src'); from calc import total; sys.exit(0 if total([1,2,3]) == 6 else 1)\"",
      evidence: "x",
    },
  ];
  writeFileSync(file, JSON.stringify(draft, null, 2), "utf8");
  t.after(() => {
    rmSync(pyRepo, { recursive: true, force: true });
  });
  const { code, out, stderr } = probeRun(
    { repo: pyRepo, file, read: () => JSON.parse(readFileSync(file, "utf8")) },
    "pass",
  );
  assert.equal(code, 2, stderr);
  assert.equal(out.verdict, "inconclusive", "no usable mutant is inconclusive, not vacuous");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).candidates[0].probe_flipped, "not-run");
  assert.match(String(readFileSync(file, "utf8")), /no usable mutant/);
});

for (const phase of ["baseline", "mutant"]) {
  for (const failure of ["timeout", "unrunnable"]) {
    test(`probe rejects ${phase} ${failure} rather than reporting sensitivity`, async (t) => {
      const d = gitSandbox(t, { location: "src/lib.mjs:3", check: DEPENDS });
      const bad =
        failure === "timeout"
          ? "setInterval(()=>{}, 1000)"
          : "console.error('ducktective: command not found'); process.exit(127)";
      const source = `#!/usr/bin/env node\nimport { total } from './src/lib.mjs';\nif (total([1,2,3]) ${phase === "baseline" ? "===" : "!=="} 6) { ${bad}; } else { process.exit(0); }\n`;
      const result = await probe({
        repo: d.repo,
        source,
        caseId: DRAFT().id,
        rank: 1,
        file: "src/lib.mjs",
        line: 3,
        timeout: 1000,
        maxBytes: 4000,
        recordedCode: phase === "baseline" ? 1 : 0,
      });
      assert.equal(result.flipped, null, JSON.stringify(result));
      assert.match(result.reason, /timeout|could not be run|not runnable/);
      assert.equal(readFileSync(join(d.repo, "src/lib.mjs"), "utf8"), LIB);
    });
  }
}

test("classify rejects signalled checks and invalid controls even with a receipt", () => {
  assert.equal(
    classify("fail", { code: null }, null, 0, { probeFlipped: true }).verdict,
    "inconclusive",
  );
  for (const control of [
    { code: 0, timedOut: true },
    { code: 0, spawnError: true },
  ]) {
    assert.equal(
      classify("fail", { code: 1 }, control, 0, { probeFlipped: true }).verdict,
      "inconclusive",
    );
  }
});

test("a passed control alone cannot confirm a pass prediction", (t) => {
  const d = withDraft(t);
  const result = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "pass",
      "--cmd",
      'node -e "process.exit(0)"',
      "--yes",
    ],
    d.repo,
  );
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.out.verdict, "inconclusive");
  assert.match(d.read().candidates[0].evidence, /--control or --probe|flipped probe/);
});

test("a passing prediction with no control and no probe confirms nothing", (t) => {
  const d = withDraft(t);
  const { code, out, stderr } = tool(
    [
      "--file",
      d.file,
      "--candidate",
      "1",
      "--predict",
      "pass",
      "--cmd",
      'node -e "process.exit(0)"',
      "--no-receipt",
      "--yes",
    ],
    d.repo,
  );
  assert.equal(code, 2, stderr);
  assert.equal(out.verdict, "inconclusive");
  assert.match(d.read().candidates[0].evidence, /--control or --probe|flipped probe/);
});
