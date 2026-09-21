/**
 * The miner turns one fix commit into a candidate instance. These tests use a
 * throwaway two-commit repo; the instance itself is verified by the materialiser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mine, parseOldHunks, runnerFor, testCommand } from "./mine.mjs";

test("parseOldHunks reads old-side ranges, including insertions", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "+++ b/x.ts",
    "@@ -10,2 +10,3 @@",
    "@@ -20,0 +21 @@",
  ].join("\n");
  assert.deepEqual(parseOldHunks(diff), [
    {
      file: "x.ts",
      lines: [
        [10, 11],
        [20, 20],
      ],
    },
  ]);
});

test("a hunk at line 0 is a file the fix added and yields no gold", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "dt-mine-new-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return (r.stdout ?? "").trim();
  };
  writeFileSync(join(repo, "note.txt"), "seed\n");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  writeFileSync(
    join(repo, "new.test.mjs"),
    "import { test } from 'node:test';\ntest('x', () => {});\n",
  );
  writeFileSync(join(repo, "brand-new.mjs"), "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "add");
  assert.throws(() => mine(repo, "HEAD"), /touched no source lines with hunks/);
});

test("testCommand and runnerFor pick the runner the repo needs", (t) => {
  assert.match(testCommand(["tests/test_x.py"], "pytest"), /^python -m pytest/);
  assert.match(testCommand(["a.test.ts"], "vitest"), /^npx vitest run/);
  assert.match(testCommand(["a.test.js"], "jest"), /^npx jest/);
  assert.match(testCommand(["a.mjs"]), /^node --test/);

  const repo = mkdtempSync(join(tmpdir(), "dt-runner-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ devDependencies: { vitest: "^2" } }));
  assert.equal(runnerFor(repo, ["a.test.ts"]), "vitest");
  assert.equal(runnerFor(repo, ["tests/test_a.py"]), "pytest");
  assert.equal(runnerFor(repo, ["a.test.mjs"]), "vitest", "the repo's runner wins");
});

test("mine builds a testPatch instance from a fix commit", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "dt-mine-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return (r.stdout ?? "").trim();
  };
  writeFileSync(join(repo, "calc.mjs"), "export function add(a, b) {\n  return a - b;\n}\n");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "buggy");
  const buggy = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "calc.mjs"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(
    join(repo, "calc.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./calc.mjs";\ntest("add", () => { assert.equal(add(2, 3), 5); });\n',
  );
  git("add", "-A");
  git("commit", "-q", "-m", "fix+test");
  const fix = git("rev-parse", "HEAD");

  const inst = mine(repo, "HEAD");
  assert.equal(inst.commit, buggy);
  assert.equal(inst.fixCommit, fix);
  assert.equal(inst.mode, "worktree");
  assert.equal(inst.testPatch, true);
  assert.match(inst.repro.command, /^node --test calc\.test\.mjs$/);
  assert.deepEqual(inst.expect.goldHunks, [{ file: "calc.mjs", start: 2, end: 2 }]);
  assert.equal(inst.source, "local");
});
