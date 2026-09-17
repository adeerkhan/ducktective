import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimInCommit, parseTouched } from "../scripts/bisect.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "scripts", "bisect.mjs");
const GIT = process.env.DT_TEST_GIT ?? "git";

const run = (args, cwd) =>
  spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: "utf8", windowsHide: true });

const git = (args, cwd) => {
  const r = spawnSync(GIT, args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const write = (repo, name, body) => {
  const path = join(repo, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
};

/** A commit whose diff touches calc.js line 2, turning the marker on. */
function repoWithBadCommit(t, { commitsAfter = 3, badIsFirst = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "dt-bisect-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.invalid"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "core.autocrlf", "false"], repo);

  // The repro: fails whenever calc.js carries the marker the bad commit added.
  write(
    repo,
    "check.mjs",
    'import { readFileSync } from "node:fs";\nconst s = readFileSync("calc.js", "utf8");\nprocess.exit(s.includes("BROKEN") ? 1 : 0);\n',
  );
  write(repo, "calc.js", "export const value = 1;\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "add calc and the repro"], repo);

  if (badIsFirst) {
    write(repo, "calc.js", "export const value = 1; // BROKEN\n");
    git(["commit", "-aq", "-m", "broken from the start"], repo);
  }

  write(repo, "calc.js", "export const value = 2; // BROKEN\n");
  git(["commit", "-aq", "-m", "feat(calc): double the value, mark it BROKEN"], repo);
  const bad = git(["rev-parse", "HEAD"], repo);

  for (let i = 0; i < commitsAfter; i++) {
    write(repo, `notes/n${i}.md`, `unrelated ${i}\n`);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", `docs: unrelated note ${i}`], repo);
  }
  return { repo, bad };
}

const repro = ["--cmd", `node check.mjs`];

test("dry run does not execute even one measurement", (t) => {
  const { repo } = repoWithBadCommit(t);
  const r = run(["--cmd", "node -e \"require('fs').writeFileSync('ran', 'yes')\""], repo);
  assert.equal(r.status, 3, r.stderr);
  assert.equal(git(["status", "--porcelain"], repo), "");
  assert.equal(git(["symbolic-ref", "--short", "HEAD"], repo), "main");
});

test("a skipped midpoint returns an interval, never an assumed boundary", (t) => {
  const { repo, bad } = repoWithBadCommit(t);
  const good = git(["rev-parse", `${bad}^`], repo);
  // The introduction itself is untestable; its descendants fail.
  const cmd = `node -e "const f=require('fs');process.exit(!f.existsSync('notes/n0.md') && f.readFileSync('calc.js','utf8').includes('BROKEN') ? 125 : f.readFileSync('calc.js','utf8').includes('BROKEN') ? 1 : 0)"`;
  const r = run(["--cmd", cmd, "--good", good, "--yes"], repo);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.bisected, false);
  assert.equal(result.first_bad_commit, undefined);
  assert.equal(result.skips, 1);
  assert.equal(result.interval.length, 2);
  assert.equal(git(["symbolic-ref", "--short", "HEAD"], repo), "main");
});

test("a checkout error after probing restores the starting branch", (t) => {
  const { repo } = repoWithBadCommit(t);
  const r = run([...repro, "--good", "missing-ref", "--yes"], repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(git(["symbolic-ref", "--short", "HEAD"], repo), "main");
});

test("a dry run prices the walk and moves nothing", (t) => {
  const { repo, bad } = repoWithBadCommit(t);
  const before = git(["rev-parse", "HEAD"], repo);
  const r = run([...repro], repo);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /DRY RUN/);
  assert.match(r.stderr, /estimated_runs/);
  assert.equal(git(["rev-parse", "HEAD"], repo), before, "HEAD must come back where it was");
  assert.ok(bad);
});

test("bisect names the commit that broke it", (t) => {
  const { repo, bad } = repoWithBadCommit(t);
  const r = run([...repro, "--yes", "--budget", "600"], repo);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.bisected, true);
  assert.equal(out.first_bad_commit.sha, bad);
  assert.match(out.first_bad_commit.subject, /double the value/);
  assert.deepEqual(
    out.touched.map((x) => x.file),
    ["calc.js"],
  );
  assert.match(git(["status", "--porcelain"], repo), /^$/, "the tree is left clean");
  assert.equal(
    git(["rev-parse", "--abbrev-ref", "HEAD"], repo),
    "main",
    "the branch you were on is the branch you get back",
  );
});

test("--claim asks whether the accusation sits in the blamed commit", (t) => {
  const { repo } = repoWithBadCommit(t);
  const inFile = JSON.parse(
    // --out lands under .git so writing it cannot dirty the tree the next test bisects.
    run([...repro, "--yes", "--claim", "calc.js:1", "--out", ".git/out.json"], repo).stdout,
  );
  assert.equal(inFile.claim_in_commit, "yes", inFile.claim_why);
  const wrongLine = JSON.parse(run([...repro, "--yes", "--claim", "calc.js:99"], repo).stdout);
  assert.equal(wrongLine.claim_in_commit, "no", "the file matches; the line does not");
  const wrongFile = JSON.parse(run([...repro, "--yes", "--claim", "app.py:1"], repo).stdout);
  assert.equal(wrongFile.claim_in_commit, "no");
  const none = JSON.parse(run([...repro, "--yes"], repo).stdout);
  assert.equal(none.claim_in_commit, "n-a", "no claim, so no comparison — not a pass");
});

test("a bug with no green ancestor is reported, not guessed at", (t) => {
  // The repro fails at EVERY revision — including the root, which the root
  // fallback now reaches. No green ref exists, so the honest answer is
  // no-good-ref, never a guessed first bad commit.
  const { repo } = repoWithBadCommit(t, { commitsAfter: 1, badIsFirst: true });
  const r = run(["--cmd", 'node -e "process.exit(1)"', "--yes"], repo);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.bisected, false);
  assert.match(out.reason, /no-good-ref/);
  assert.ok(out.walked.length >= 1, "say which revisions were tested");
});

test("a good root just past the doubling grid is still found", (t) => {
  // commitsAfter=5 puts the root at depth 6 from the bad tip: the walk probes
  // ~1,2,4 (all bad descendants), then ~8 — missing — and the old walk broke on
  // the first missing ref, reporting a bug that was always there. No --good:
  // discovery itself must reach the root (directly or by fallback) to find it.
  const { repo, bad } = repoWithBadCommit(t, { commitsAfter: 5 });
  const r = run([...repro, "--yes", "--bad", bad], repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.bisected, true);
  assert.match(out.first_bad_commit.subject, /double the value/);
});

test("a merge-heavy history still bisects to the marker commit", (t) => {
  // `rev-list --no-merges good..bad` drops the merge and lists its two parent
  // lines interleaved by date; "is bad" is not monotone along that array, and
  // with a commit on main AFTER the merge the search can blame the innocent
  // sibling. First-parent order is the line.
  const { repo, bad } = repoWithBadCommit(t, { commitsAfter: 3 });
  const good = git(["rev-parse", `${bad}^`], repo);
  git(["checkout", "-q", "-b", "feature", "HEAD~2"], repo);
  write(repo, "feature.md", "parallel work\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "parallel feature"], repo);
  const feature = git(["rev-parse", "HEAD"], repo);
  git(["checkout", "-q", "main"]);
  git(["merge", "-q", "--no-ff", "-m", "merge feature", feature], repo);
  write(repo, "notes/n-after.md", "after the merge\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "docs: after merge"], repo);
  const tip = git(["rev-parse", "HEAD"], repo);
  const r = run([...repro, "--yes", "--bad", tip, "--good", good], repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.bisected, true);
  assert.match(out.first_bad_commit.subject, /double the value/);
  assert.match(out.first_bad_commit.subject, /calc|double/, "not an innocent commit");
});

test("discovery disagreement is an abort, not a silent continue", (t) => {
  // A deterministic flip: each invocation increments a counter OUTSIDE the repo
  // (an untracked file inside it would trip the dirty-tree guard) and exits
  // 0/1 alternately. With --repeat 2 every probe disagrees, deterministically.
  const { repo } = repoWithBadCommit(t, { commitsAfter: 3 });
  const outside = mkdtempSync(join(tmpdir(), "dt-flip-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const flipper = join(outside, "flipper.mjs");
  const state = join(outside, "flip-state");
  writeFileSync(
    flipper,
    'import { readFileSync, writeFileSync } from "node:fs";\n' +
      "const state = process.argv[2];\n" +
      "let n = 0;\n" +
      'try { n = Number(readFileSync(state, "utf8")) || 0; } catch {}\n' +
      "writeFileSync(state, String(n + 1));\n" +
      "process.exit(n % 2);\n",
    "utf8",
  );
  const r = run(["--cmd", `node "${flipper}" "${state}"`, "--yes", "--repeat", "2"], repo);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.flaky, true, "a flaky walk is reported, not ignored");
});

test("an uncommitted tree stops the walk before it moves HEAD", (t) => {
  const { repo } = repoWithBadCommit(t);
  write(repo, "scratch.txt", "work in progress\n");
  const r = run([...repro, "--yes"], repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /uncommitted changes/);
  assert.match(git(["status", "--porcelain"], repo), /scratch\.txt/, "nothing was touched");
});

test("a command that passes at the tip has nothing to bisect", (t) => {
  const { repo } = repoWithBadCommit(t);
  const r = run(["--cmd", 'node -e "process.exit(0)"', "--yes"], repo);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /nothing here to bisect/);
});

test("the budget refuses an estimate it cannot afford, before running it", (t) => {
  const { repo } = repoWithBadCommit(t);
  const r = run([...repro, "--yes", "--budget", "0"], repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.refused, true);
  assert.match(out.why, /over the --budget/);
});

// --- the two pure halves, which do not need a repository -------------------

const DIFF = [
  "diff --git a/src/a.py b/src/a.py",
  "--- a/src/a.py",
  "+++ b/src/a.py",
  "@@ -10,0 +11,3 @@",
  "@@ -40 +42 @@",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,2 +1,1 @@",
].join("\n");

test("the diff becomes file + hunk ranges, and a claim is checked against them", () => {
  assert.deepEqual(parseTouched(DIFF), [
    {
      file: "src/a.py",
      lines: [
        [11, 13],
        [42, 42],
      ],
    },
    { file: "README.md", lines: [[1, 1]] },
  ]);
  assert.equal(claimInCommit("src/a.py:12", parseTouched(DIFF)).verdict, "yes");
  assert.equal(claimInCommit("src/a.py:42", parseTouched(DIFF)).verdict, "yes");
  const miss = claimInCommit("src/a.py:99", parseTouched(DIFF));
  assert.equal(miss.verdict, "no");
  assert.match(miss.why, /hunks: 11-13, 42-42/);
  assert.equal(
    claimInCommit("src\\a.py:11", parseTouched(DIFF)).verdict,
    "no",
    "separators are not normalised",
  );
  assert.equal(claimInCommit("nonsense", parseTouched(DIFF)).verdict, "n-a");
});

test("an empty diff and a file-only claim behave", () => {
  assert.deepEqual(parseTouched(""), []);
  assert.equal(claimInCommit("a.py", []).verdict, "no");
  assert.equal(claimInCommit(null, [{ file: "a.py", lines: [[1, 2]] }]).verdict, "n-a");
});
