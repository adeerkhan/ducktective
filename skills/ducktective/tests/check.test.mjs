import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimLocation, grade, renderBox } from "../scripts/check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "scripts", "check.mjs");

const run = (args, cwd) =>
  spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: "utf8", windowsHide: true });

const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// --- the grading arithmetic, which must never be generous ------------------

const row = (id, state) => [id, id, state, "e"];

test("a grade counts what a tool proved, and an unattempted row is not a point", () => {
  const all = grade([
    row("reproduces", "yes"),
    row("regression", "yes"),
    row("claim", "yes"),
    row("discriminates", "yes"),
  ]);
  assert.equal(all.letter, "A");
  assert.equal(all.earned, 4);
  assert.equal(all.total, 4);
  const half = grade([row("reproduces", "yes"), row("regression", "n/a"), row("claim", "n/a")]);
  assert.equal(half.earned, 1);
  assert.equal(half.total, 3, "rows nobody attempted still count against the grade");
  assert.equal(half.letter, "D");
});

test("missing a bisect hunk is not proof the cause is wrong", () => {
  // An enabling commit can expose an older defect; hunk overlap is supporting
  // evidence, not a causal oracle.
  const g = grade([
    row("reproduces", "yes"),
    row("regression", "yes"),
    row("claim", "no"),
    row("discriminates", "yes"),
    row("control", "yes"),
    row("prediction", "yes"),
    row("survives", "yes"),
  ]);
  assert.equal(g.letter, "B");
  assert.equal(g.wrongCause, false);
  assert.equal(g.earned, 6, "the arithmetic still reports the six it earned");
});

test("a contradicted prediction cannot earn a positive grade", () => {
  const g = grade([
    row("reproduces", "yes"),
    row("regression", "yes"),
    row("claim", "yes"),
    row("discriminates", "yes"),
    row("control", "yes"),
    row("prediction", "no"),
    row("survives", "yes"),
  ]);
  assert.equal(g.letter, "F");
});

test("a stale ticket is not a bad grade", () => {
  // Refusing to name a cause for something that does not reproduce is the answer
  // this project rewards; grading it F would train the agent to invent one.
  const g = grade([row("reproduces", "no"), row("regression", "n/a")]);
  assert.equal(g.letter, "n/a");
  assert.match(g.note, /no defect to grade/);
  const broke = grade([row("reproduces", "n/a"), row("regression", "n/a")]);
  assert.equal(broke.letter, "F", "a harness that never ran is not a stop, it is a failure");
});

test("the box shows n/a distinctly from a failure", () => {
  const box = renderBox(
    [
      ["reproduces", "reproduces", "yes", "`reproduced`, exit 1, 3 in-repo frames"],
      ["claim", "claim ∈ commit", "n/a", "no commit to compare"],
      ["control", "control", "no", "exit 2"],
    ],
    { claim: "app.py:41 is wrong", caseId: "DT-1" },
  );
  assert.match(box, /reproduces\s+✓/);
  assert.match(box, /claim ∈ commit\s+·\s+no commit to compare/);
  assert.match(box, /control\s+✗\s+exit 2/);
  assert.match(box, /GRADE: D\s+\(1\/3 earned, 1 not attempted, 1 disproved\)\s+case DT-1/);
});

test("a claim's location is parsed out of prose, or not at all", () => {
  assert.deepEqual(claimLocation("candidate.py:411 returns None when the cache is cold"), {
    file: "candidate.py",
    line: 411,
  });
  assert.deepEqual(claimLocation("the cache path is wrong at src\\cache.js:12 somewhere"), {
    file: "src\\cache.js",
    line: 12,
  });
  assert.equal(claimLocation("the cache is never invalidated"), null);
});

// --- end to end, in a repository with one real regression ------------------

function buggyRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), "dt-check-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.invalid"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "core.autocrlf", "false"], repo);
  // A real assertion, so the traceback names the file: the gate's evidence rule
  // refuses a bare `exit 1` with no in-repo frame, and it is right to.
  writeFileSync(
    join(repo, "suite.mjs"),
    'import assert from "node:assert/strict";\nimport { total } from "./lib.mjs";\nassert.equal(total([1,2,3]), 6, "totals drop a row");\n',
    "utf8",
  );
  writeFileSync(
    join(repo, "lib.mjs"),
    "export function total(rows) {\n  let sum = 0;\n  for (const r of rows) sum += r;\n  return sum;\n}\n",
    "utf8",
  );
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "add the suite"], repo);
  // The regression: the loop stops one short.
  writeFileSync(
    join(repo, "lib.mjs"),
    "export function total(rows) {\n  let sum = 0;\n  for (const r of rows.slice(0, -1)) sum += r;\n  return sum;\n}\n",
    "utf8",
  );
  git(["commit", "-aq", "-m", "feat(total): rework the loop"], repo);
  return repo;
}

test("check composes the tools and grades the claim they can prove", (t) => {
  const repo = buggyRepo(t);
  const r = run(
    [
      "--claim",
      "lib.mjs:3 drops the last row",
      "--repro",
      "node suite.mjs",
      "--check",
      "node -e \"import('./lib.mjs').then(m=>process.exit(m.total([1,2,3])===3?1:0))\"",
      "--predict",
      "fail",
      "--control",
      'node -e "process.exit(0)"',
      "--blind",
      "node -e \"import('./lib.mjs').then(m=>process.exit(m.total([1,2,3])===3?2:0))\"",
      "--out",
      join(repo, ".ducktective", "check.json"),
      "--yes",
    ],
    repo,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /claim ∈ commit\s+✓/, "bisect blamed a commit that touches line 3");
  assert.match(r.stderr, /reproduces\s+✓/);
  const json = JSON.parse(r.stdout);
  assert.equal(json.graded, true);
  const table = JSON.parse(readFileSync(json.out, "utf8"));
  assert.equal(table.bisect.bisected, true);
  assert.equal(table.bisect.claim_in_commit, "yes");
  assert.equal(table.rows.find((r) => r.id === "prediction").state, "yes");
  assert.ok(existsSync(join(repo, ".ducktective", "cases.jsonl")), "a grade has a receipt");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "main", "your branch comes back");
});

test("a falsified prediction gets no credit and the default result exists", (t) => {
  const repo = buggyRepo(t);
  const r = run(
    [
      "--claim",
      "lib.mjs:3 drops the last row",
      "--repro",
      "node suite.mjs",
      "--check",
      'node -e "process.exit(0)"',
      "--predict",
      "fail",
      "--skip-bisect",
      "--yes",
    ],
    repo,
  );
  const result = JSON.parse(r.stdout);
  assert.ok(existsSync(result.out), "reported result path must exist without --out");
  const table = JSON.parse(readFileSync(result.out, "utf8"));
  assert.equal(table.rows.find((r) => r.id === "prediction").state, "no");
  assert.equal(result.letter, "F");
});

test("invalid numeric options are refused before reproduction", (t) => {
  const repo = buggyRepo(t);
  for (const option of [
    ["--timeout", "NaN"],
    ["--budget", "-1"],
  ]) {
    const r = run(
      ["--claim", "lib.mjs:3 wrong", "--repro", "node suite.mjs", ...option, "--yes"],
      repo,
    );
    assert.notEqual(r.status, 0);
    assert.ok(!existsSync(join(repo, ".ducktective")));
  }
});

test("a non-reproducing claim is graded as a stop, and the box says so", (t) => {
  const repo = buggyRepo(t);
  const r = run(
    ["--claim", "lib.mjs:1 is wrong", "--repro", 'node -e "process.exit(0)"', "--yes"],
    repo,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /reproduces\s+✗\s+`does_not_reproduce`/);
  assert.match(r.stderr, /GRADE: n\/a/);
  assert.match(r.stderr, /note: no defect to grade/);
});

test("nothing runs without --yes, and the plan shows the real commands", (t) => {
  const repo = buggyRepo(t);
  const before = git(["rev-parse", "HEAD"], repo);
  const r = run(["--claim", "lib.mjs:3 is wrong", "--repro", "node suite.mjs"], repo);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /reproduce: --cmd node suite\.mjs/);
  assert.match(r.stderr, /bisect: --cmd node suite\.mjs --claim lib\.mjs:3 is wrong --budget 300/);
  assert.ok(!/--yes/.test(r.stderr), "the plan must not imply the approval is already given");
  assert.equal(git(["rev-parse", "HEAD"], repo), before);
  assert.ok(!existsSync(join(repo, ".ducktective")), "a dry run writes nothing");
});
