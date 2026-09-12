import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  coveredSites,
  detectRunner,
  parseAssertion,
  coverageHint,
  baseName,
  isAbsoluteLike,
  parseFrames,
  RUNNER_MISUSE,
  seedCandidates,
  USAGE as USAGE_TEXT,
} from "../scripts/reproduce.mjs";
import {
  policyViolations,
  readStore,
  repoRoot,
  validateSchema,
  SCHEMA,
  writeCase,
} from "../scripts/lib/case-file.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPRODUCE = join(HERE, "..", "scripts", "reproduce.mjs");
const PY_FIX = join(HERE, "fixtures", "py");
const NODE_FIX = join(HERE, "fixtures", "node");

/** The CI images and Windows laptops disagree on the name of Python. */
function findPython() {
  for (const exe of ["python", "python3", "py"]) {
    const probe = spawnSync(exe, ["-c", "print(1)"], { windowsHide: true, encoding: "utf8" });
    if (!probe.error && probe.status === 0) return exe;
  }
  return null;
}
const PY = findPython();

/**
 * Run the tool. A crash must report what the tool said, not surface as a bare
 * SyntaxError from an empty stdout.
 */
function harness(args, cwd) {
  const run = spawnSync(process.execPath, [REPRODUCE, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  let draft;
  try {
    draft = JSON.parse(run.stdout);
  } catch {
    throw new Error(
      `no JSON on stdout (status ${run.status})\nstderr: ${run.stderr.slice(0, 600)}\nstdout: ${run.stdout.slice(0, 200)}`,
    );
  }
  return { code: run.status, draft, stderr: run.stderr };
}

// --- the gate, against real processes -------------------------------------

test(
  "a genuinely failing run is reproduced, and the throwing frame ranks first",
  { skip: !PY && "no python" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "dt-draft-"));
    const out = join(dir, "draft.json");
    const { code, draft } = harness(
      [
        "--cmd",
        `${PY} -m unittest -q test_totals`,
        "--cwd",
        ".",
        "--symptom",
        "totals drop the last row",
        "--out",
        out,
      ],
      PY_FIX,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(out, "utf8")),
      draft,
      "--out must hold the same draft as stdout",
    );
    assert.equal(code, 0, "a reproduction must exit 0 so the investigation may continue");
    assert.equal(draft.reproduction.outcome, "reproduced");
    assert.equal(draft.reproduction.runner, "unittest");
    assert.equal(draft.status, "open");
    assert.ok(draft.reproduction.duration_ms > 0, "the run must have actually taken time");
    assert.equal(draft.reproduction.exit_code, 1);
    assert.match(draft.reproduction.stderr, /IndexError/);
    assert.match(draft.reproduction.stack[0], /app\.py", line \d+, in total$/);
    assert.match(draft.reproduction.stack.at(-1), /test_totals\.py/, "the caller must rank last");
    assert.match(draft.candidates[0].location, /^app\.py:\d+ total\(\)$/);
    assert.equal(draft.candidates[0].verdict, "pending");
    assert.match(draft.candidates[0].why, /failing traceback/);
    assert.deepEqual(validateSchema(draft, SCHEMA), []);
    rmSync(dir, { recursive: true, force: true });
  },
);

/**
 * `python crash.py` has no runner name. Keying the frame reversal on the runner
 * left the caller ranked above the throwing function for exactly the "plain
 * Python scripts" case the design doc puts in Week 1.
 */
test(
  "a plain python script is ranked nearest-fault-first too",
  { skip: !PY && "no python" },
  () => {
    const { code, draft } = harness(
      [
        "--cmd",
        `${PY} -c "from app import total; total([1, 2, 3, 4])"`,
        "--cwd",
        ".",
        "--symptom",
        "crashes on a full list",
      ],
      PY_FIX,
    );
    assert.equal(code, 0);
    assert.equal(draft.reproduction.runner, "unknown", "no runner was detected…");
    assert.match(
      draft.candidates[0].location,
      /^app\.py:\d+ total\(\)$/,
      "…so ordering must come from the frame syntax",
    );
  },
);

test(
  "a run that passes stops the investigation with zero candidates",
  { skip: !PY && "no python" },
  () => {
    const { code, draft } = harness(
      [
        "--cmd",
        `${PY} -m unittest -q test_dnr`,
        "--cwd",
        ".",
        "--symptom",
        "totals drop the last row",
      ],
      PY_FIX,
    );
    assert.equal(code, 1, "does_not_reproduce must hard-fail the step");
    assert.equal(draft.reproduction.outcome, "does_not_reproduce");
    assert.equal(draft.status, "does_not_reproduce");
    assert.deepEqual(draft.candidates, []);
    assert.match(draft.notes, /ticket may be stale/);
    // A stopped case must be writable as-is, and a speculated version must not be.
    assert.deepEqual([...validateSchema(draft, SCHEMA), ...policyViolations(draft)], []);
    const speculating = {
      ...draft,
      candidates: [
        { location: "app.py:6", hypothesis: "x", check: "y", verdict: "falsified", evidence: "z" },
      ],
    };
    assert.match(policyViolations(speculating).join("\n"), /zero candidates/);
  },
);

test("the node:test reporter's stack parses with the failing frame first", () => {
  const { code, draft } = harness(
    ["--cmd", "node --test faulty.mjs", "--cwd", ".", "--symptom", "totals drop the last row"],
    NODE_FIX,
  );
  assert.equal(code, 0);
  assert.equal(draft.reproduction.runner, "node-test");
  assert.equal(draft.reproduction.outcome, "reproduced");
  assert.match(draft.reproduction.stack[0], /faulty\.mjs:\d+:\d+/);
  assert.match(draft.candidates[0].location, /faulty\.mjs/);
});

/**
 * `unittest no_such_module` exits 1 with a traceback that never enters the repo.
 * Reading that as a reproduction is the false positive that defeats the skill's
 * first success metric: stopping on non-reproducing symptoms.
 */
test(
  "a runner that never collected anything is an error, not a reproduction",
  { skip: !PY && "no python" },
  () => {
    const { code, draft } = harness(
      [
        "--cmd",
        `${PY} -m unittest -q no_such_module`,
        "--cwd",
        ".",
        "--symptom",
        "totals drop the last row",
      ],
      PY_FIX,
    );
    assert.equal(code, 2);
    assert.equal(draft.reproduction.outcome, "error");
    assert.equal(draft.status, "unverified");
    assert.match(draft.leading_hypothesis, /harness could not evaluate/);
    assert.deepEqual(draft.candidates, []);
    assert.deepEqual(validateSchema(draft, SCHEMA), [], "an error draft must be storable");
    assert.deepEqual(policyViolations(draft), []);
  },
);

test("a command that cannot start is an error, never a verdict", () => {
  const { code, draft } = harness(
    ["--cmd", "ducktective-no-such-binary --version", "--symptom", "x"],
    PY_FIX,
  );
  assert.equal(code, 2);
  assert.equal(draft.reproduction.outcome, "error");
  assert.equal(draft.status, "unverified");
  assert.deepEqual(draft.candidates, []);
});

test("a hung command is killed and reported as an error", () => {
  const { code, draft } = harness(
    ["--cmd", 'node -e "setTimeout(() => {}, 9000)"', "--timeout", "400", "--symptom", "hangs"],
    NODE_FIX,
  );
  assert.equal(code, 2);
  assert.equal(draft.reproduction.outcome, "error");
  assert.match(draft.notes, /killed the whole process tree after 400 ms/);
  assert.ok(
    draft.reproduction.duration_ms < 4000,
    `killed at ~400 ms, took ${draft.reproduction.duration_ms}`,
  );
});

test("a flooded runner cannot exhaust memory, and head and tail survive", () => {
  const { code, draft } = harness(
    [
      "--cmd",
      `node -e "console.log('y'.repeat(2000000))"`,
      "--cwd",
      ".",
      "--max-bytes",
      "100",
      "--symptom",
      "flood",
    ],
    NODE_FIX,
  );
  assert.equal(code, 1, "a passing command still means does_not_reproduce, flood or not");
  assert.ok(
    draft.reproduction.stdout.length < 500,
    `stdout must stay bounded, got ${draft.reproduction.stdout.length}`,
  );
  assert.match(draft.reproduction.stdout, /chars elided/);
  assert.match(draft.notes, /stopped reading stdout after \d+ bytes/);
});

test("coverage is only suggested when the repo's own interpreter can collect it", () => {
  const yes = () => true;
  const no = () => false;
  const hint = coverageHint("python -m unittest -q", "/repo", yes);
  assert.match(hint, /coverage run -m unittest -q/);
  assert.match(hint, /coverage json -o cov-failing\.json/);
  assert.match(hint, /--baseline/);
  assert.match(coverageHint("python -m pytest -q", "/repo", yes), /coverage run -m pytest -q/);
  assert.equal(
    coverageHint("python -m unittest -q", "/repo", no),
    null,
    "no coverage.py, no suggestion",
  );

  // Windows venv paths use backslashes. Two bugs lived here: a forward-slash-only
  // split made the whole path the "basename" (hint dead on Windows), and
  // `path.basename` does not split on them at all (hint dead on Linux CI). The
  // `?? ""` that used to sit on these calls turned a null into an empty string
  // and made the failure message lie about what came back.
  const venv = String.raw`"C:\Users\dev\.venv-eval\Scripts\python.exe" -m pytest -q`;
  assert.match(coverageHint(venv, "C:/repo", yes), /coverage run -m pytest -q/);
  assert.match(
    coverageHint(String.raw`C:\repo\.venv\Scripts\python.exe -m pytest -q`, "C:/repo", yes),
    /coverage/,
  );
});

test("path classification gives the same answer on every OS", () => {
  // Contributors run Windows, CI runs Linux, and a traceback may be written on
  // one and read on the other. `isAbsolute("C:/app/x.py")` and `basename` both
  // disagree across those, which flipped `inside` and killed the coverage hint.
  for (const p of [
    "C:/Users/dev/app.py",
    "C:\\Users\\dev\\app.py",
    "/srv/app.py",
    "//server/share/a.py",
  ]) {
    assert.equal(isAbsoluteLike(p), true, `${p} must read as absolute on any host`);
  }
  for (const p of ["app.py", "src/app.py", "../up.py"]) {
    assert.equal(isAbsoluteLike(p), false, `${p} must stay relative on any host`);
  }
  assert.equal(baseName(String.raw`C:\repo\.venv\Scripts\python.exe`), "python.exe");
  assert.equal(baseName("/repo/.venv/bin/python3"), "python3");
  assert.equal(baseName("app.py"), "app.py");
  // The classification the CI failure was about, asserted directly this time.
  assert.equal(
    parseFrames('  File "C:/Python314/unittest/main.py", line 6, in main', "C:/proj")[0].inside,
    false,
  );
});

test("launchers and shells are never probed for coverage", () => {
  const yes = () => true;
  const none = (cmd) =>
    assert.equal(coverageHint(cmd, "/repo", yes), null, `should not probe: ${cmd}`);
  none("npm test");
  none("make check");
  // `poetry`/`pipenv` are launchers: probing them can resolve an env, build a
  // venv, or prompt — for a hint. A bare `pytest` names no interpreter at all.
  none("poetry run pytest -q");
  none("pipenv run pytest -q");
  none("pytest -q tests");
  none("cd tests && pytest -q");
  none("PYTHONPATH=x python -m pytest -q");
});

test("--depth stays free for the doc's escalation flag", () => {
  // docs/ducktective-design.md L131 defines --depth as 1 = one candidate hard,
  // 2 = escalate. A candidate cap wearing that name would collide with Days 13-14.
  assert.doesNotMatch(USAGE_TEXT, /--depth/);
  assert.match(USAGE_TEXT, /--max-candidates N/);
});

test(
  "--max-candidates narrows the lead list without reordering it",
  { skip: !PY && "no python" },
  () => {
    const one = harness(
      [
        "--cmd",
        `${PY} -m unittest -q test_totals`,
        "--cwd",
        ".",
        "--symptom",
        "x",
        "--max-candidates",
        "1",
      ],
      PY_FIX,
    ).draft;
    assert.equal(one.candidates.length, 1);
    assert.match(one.candidates[0].location, /^app\.py:\d+ total\(\)$/);
  },
);

test(
  "an oversized --max-candidates is clamped out loud, not silently",
  { skip: !PY && "no python" },
  () => {
    const { stderr } = harness(
      [
        "--cmd",
        `${PY} -m unittest -q test_totals`,
        "--cwd",
        ".",
        "--symptom",
        "x",
        "--max-candidates",
        "9",
      ],
      PY_FIX,
    );
    assert.match(stderr, /--max-candidates 9 clamped to 5/);
  },
);

test("a bad --max-bytes is rejected instead of silently blanking the evidence", () => {
  const run = spawnSync(
    process.execPath,
    [REPRODUCE, "--cmd", "node --version", "--max-bytes", "abc"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--max-bytes wants a positive whole number/);
});

// --- the parsers, without a subprocess --------------------------------------

const PY_TB = [
  "Traceback (most recent call last):",
  '  File "t/test_x.py", line 7, in test_sums',
  "    self.assertEqual(total([1, 2]), 3)",
  '  File "app.py", line 6, in total',
  "    return sum(rows[start:end])",
  "AssertionError: 2 != 3",
].join("\n");

test("detectRunner reads the command, then the output", () => {
  assert.equal(detectRunner("pytest -q tests", ""), "pytest");
  assert.equal(detectRunner("python -m unittest -q", ""), "unittest");
  assert.equal(detectRunner("node --test .", ""), "node-test");
  // A V8 stack is not proof of node:test: a plain `node main.mjs` crash prints
  // one too, and calling it node-test would be a guess about the runner.
  assert.equal(detectRunner("make check", "  at fn (/a/b.js:1:2)"), "unknown");
  assert.equal(detectRunner("npm run test", "ℹ fail 1"), "node-test");
  assert.equal(detectRunner("./run.sh", "boom"), "unknown");
});

test("python frames are reversed by syntax; node internals are dropped", () => {
  const frames = parseFrames(PY_TB);
  assert.equal(frames[0].file, "app.py");
  assert.equal(frames[0].line, 6);
  assert.equal(frames[0].fn, "total");
  assert.equal(frames[0].inside, true);
  assert.equal(frames[1].file, "t/test_x.py");
  const v8 = parseFrames(
    [
      "    at getUser (C:/p/src/auth.ts:41:12)",
      "    at node:internal/main/run:1:1",
      "    at C:/p/src/index.ts:3:1",
    ].join("\n"),
    "C:/p",
  );
  assert.deepEqual(
    v8.map((f) => f.file),
    ["src/auth.ts", "src/index.ts"],
  );
  assert.deepEqual(
    v8.map((f) => f.inside),
    [true, true],
  );
  assert.equal(
    parseFrames('  File "C:/Python314/unittest/main.py", line 6, in main', "C:/proj")[0].inside,
    false,
  );
});

/**
 * A trailing `|` in an alternation is invisible and total: it matches the empty
 * string, so the runner-misuse classifier returns true for every run and the gate
 * silently stops distinguishing a reproduced bug from a broken command.
 */
test("RUNNER_MISUSE matches the failures it means, and nothing else", () => {
  for (const [signature, why] of [
    ["no tests ran in 0.01s", "pytest collected nothing"],
    ["no tests were collected", "stale test names"],
    ["ERROR: file or directory not found: tests/totals_test.py", "path from a deleted branch"],
    ["usage: pytest [options]", "bad flag"],
    ["pytest: error: unrecognized arguments: --nope", "flag that does not exist"],
    ["ImportError: cannot import name 'subtotal' from 'money'", "unimportable module"],
    ["Error: Cannot find module 'C:/app/gone.mjs'", "node pointed at a missing file"],
    ["interrupted:", "user cancelled the run"],
    ["empty test suite", "pytest exited 5"],
  ]) {
    assert.ok(RUNNER_MISUSE.test(signature), `should classify as runner misuse: ${why}`);
  }
  for (const noise of [
    "IndexError: list index out of range",
    "AssertionError: 6 != 10",
    '  File "app.py", line 7, in total',
    "TypeError: Cannot read properties of undefined (reading 'id')",
    "",
    "test_money.py:5: AssertionError",
  ]) {
    assert.equal(
      RUNNER_MISUSE.test(noise),
      false,
      `RUNNER_MISUSE_REJECTS_NOISE: matched ordinary failure text ${JSON.stringify(noise)} — an alternative is probably empty`,
    );
  }
});

test("pytest's assertion line becomes the candidate rationale", () => {
  assert.equal(parseAssertion("E   assert 6 == 10\n"), "assert 6 == 10");
  assert.equal(parseAssertion("nothing here"), null);
});

test("coverage without a passing baseline lists everything, with one it lists only fail-only lines", () => {
  const failing = { files: { "app.py": { executed_lines: [4, 5, 6] } } };
  const baseline = { files: { "app.py": { executed_lines: [4, 5] } } };
  assert.deepEqual(
    coveredSites(failing, null).map((s) => s.line),
    [4, 5, 6],
  );
  assert.deepEqual(
    coveredSites(failing, baseline).map(({ file, line }) => ({ file, line })),
    [{ file: "app.py", line: 6 }],
  );
});

test("seedCandidates ranks local leads first and dependency frames last", () => {
  const frames = [
    ...parseFrames(PY_TB),
    { file: "C:/Python314/lib/copy.py", line: 1, fn: "_deepcopy", raw: "", inside: false },
  ];
  const sites = [
    { file: "app.py", line: 6, inside: true },
    { file: "app.py", line: 5, inside: true },
  ];
  const out = seedCandidates(frames, sites, 5, "assert 2 == 3");
  assert.equal(out[0].location, "app.py:6 total()");
  assert.match(out[0].why, /failing traceback and covered/);
  assert.deepEqual(
    out.map((c) => c.rank),
    [1, 2, 3, 4],
  );
  assert.match(out.at(-1).why, /outside this repo/);
  assert.equal(
    out.every((c) => c.verdict === "pending"),
    true,
  );
  assert.equal(seedCandidates(frames, sites, 1, null).length, 1);
});

// --- the store, and where it lands ------------------------------------------

test("repoRoot stops at the directory it was given when no .git exists", () => {
  const orphan = join(mkdtempSync(join(tmpdir(), "dt-nogit-")), "pkg");
  mkdirSync(orphan, { recursive: true });
  try {
    // A tarball/CI checkout must not put `.ducktective/` at the drive root.
    assert.equal(realpathSync(repoRoot(orphan)), realpathSync(orphan));
  } finally {
    rmSync(dirname(orphan), { recursive: true, force: true });
  }
});

test("an update preserves a line the store could not parse", () => {
  const repo = mkdtempSync(join(tmpdir(), "dt-corrupt-"));
  try {
    writeCase(
      {
        id: "DT-1",
        opened_at: "x",
        symptom: "s",
        reproduction: { command: "c", outcome: "reproduced" },
        candidates: [],
        status: "open",
        confidence: "none",
      },
      repo,
    );
    const store = join(repo, ".ducktective", "cases.jsonl");
    const damaged = readFileSync(store, "utf8").trim() + '\n{"truncated mid-write\n';
    writeFileSync(store, damaged, "utf8");
    writeCase(
      {
        id: "DT-2",
        opened_at: "x",
        symptom: "s2",
        reproduction: { command: "c", outcome: "reproduced" },
        candidates: [],
        status: "open",
        confidence: "none",
      },
      repo,
    );
    const { raw, corrupt } = readStore(repo);
    assert.equal(raw.length, 3, "both cases plus the broken line");
    assert.equal(corrupt.length, 1);
    assert.equal(raw[1], '{"truncated mid-write');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
