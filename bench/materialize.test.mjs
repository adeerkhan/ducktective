/**
 * The materialiser verifies an instance's premise — a buggy checkout, a failing
 * repro, and gold hunks that name real lines — before any arm runs against it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addWorktree,
  checkInstances,
  loadInstances,
  materialize,
  removeWorktree,
} from "./materialize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "materialize.mjs");

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return (r.stdout ?? "").trim();
}

/** A git repo with a bug on calc.mjs:2, and a test that fails because of it. */
function buggyRepo(t, { buggy = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "dt-mat-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(
    join(repo, "calc.mjs"),
    `export function add(a, b) {\n  return a ${buggy ? "-" : "+"} b;\n}\n`,
  );
  writeFileSync(
    join(repo, "calc.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./calc.mjs";\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
  );
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.invalid"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "core.autocrlf", "false"], repo);
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "seed"], repo);
  return { repo, sha: git(["rev-parse", "HEAD"], repo) };
}

function instance(repo, sha, overrides = {}) {
  return {
    id: "local-1",
    source: "local",
    repo,
    commit: sha,
    repro: { command: "node --test calc.test.mjs" },
    expect: { goldHunks: [{ file: "calc.mjs", start: 2, end: 2 }] },
    ...overrides,
  };
}

/** A repo with a buggy commit and a fix commit, plus a standalone oracle file. */
function twoCommitRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), "dt-oracle-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const g = (...args) => git(args, repo);
  writeFileSync(join(repo, "calc.mjs"), "export function add(a, b) {\n  return a - b;\n}\n");
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  g("add", "-A");
  g("commit", "-q", "-m", "buggy");
  const buggySha = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "calc.mjs"), "export function add(a, b) {\n  return a + b;\n}\n");
  g("add", "-A");
  g("commit", "-q", "-m", "fix");
  const fixSha = g("rev-parse", "HEAD");
  const dir = mkdtempSync(join(tmpdir(), "dt-oracle-src-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const oracle = join(dir, "dt-oracle.mjs");
  writeFileSync(
    oracle,
    'import { add } from "./calc.mjs";\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n',
  );
  return { repo, buggySha, fixSha, oracle };
}

/** A repo where the fix commit adds the test that the buggy code fails. */
function testPatchRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), "dt-tp-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const g = (...args) => git(args, repo);
  writeFileSync(join(repo, "calc.mjs"), "export function add(a, b) {\n  return a - b;\n}\n");
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  g("add", "-A");
  g("commit", "-q", "-m", "buggy");
  const buggySha = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "calc.mjs"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(
    join(repo, "calc.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./calc.mjs";\ntest("add", () => { assert.equal(add(2, 3), 5); });\n',
  );
  g("add", "-A");
  g("commit", "-q", "-m", "fix+test");
  const fixSha = g("rev-parse", "HEAD");
  return { repo, buggySha, fixSha };
}

test("materialises a buggy instance and verifies the premise", (t) => {
  const { repo, sha } = buggyRepo(t);
  const dest = join(mkdtempSync(join(tmpdir(), "dt-dest-")), "local-1");
  t.after(() => rmSync(dirname(dest), { recursive: true, force: true }));
  const r = materialize(instance(repo, sha), { dest });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.head, sha, "the clone is at the named commit");
  assert.notEqual(r.repro_exit, 0, "the repro fails on the buggy commit");
  assert.ok(existsSync(join(dest, "calc.mjs")));
});

test("refuses an instance whose repro passes — it is not buggy", (t) => {
  const { repo, sha } = buggyRepo(t, { buggy: false });
  const dest = join(mkdtempSync(join(tmpdir(), "dt-dest-")), "local-1");
  t.after(() => rmSync(dirname(dest), { recursive: true, force: true }));
  const r = materialize(instance(repo, sha), { dest });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /not buggy/);
});

test("refuses a gold hunk that is past the end of its file", (t) => {
  const { repo, sha } = buggyRepo(t);
  const dest = join(mkdtempSync(join(tmpdir(), "dt-dest-")), "local-1");
  t.after(() => rmSync(dirname(dest), { recursive: true, force: true }));
  const bad = instance(repo, sha, {
    expect: { goldHunks: [{ file: "calc.mjs", start: 1, end: 999 }] },
  });
  const r = materialize(bad, { dest });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /past the file/);
});

test("refuses a repo that is not a git checkout", (t) => {
  const plain = mkdtempSync(join(tmpdir(), "dt-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  const r = materialize(
    {
      id: "x",
      source: "local",
      repo: plain,
      repro: { command: "true" },
      expect: { goldHunks: [{ file: "a", start: 1, end: 1 }] },
    },
    { dest: join(plain, "dest") },
  );
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /not a git repository/);
});

test("loadInstances reads one-or-many and checkInstances reports unknowns", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dt-inst-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { repo, sha } = buggyRepo(t);
  writeFileSync(
    join(dir, "a.json"),
    JSON.stringify([instance(repo, sha, { id: "a" }), instance(repo, sha, { id: "a2" })]),
  );
  writeFileSync(join(dir, "b.json"), JSON.stringify(instance(repo, sha, { id: "b" })));
  const loaded = loadInstances(dir);
  assert.deepEqual(
    loaded.map((i) => i.id),
    ["a", "a2", "b"],
  );
  assert.deepEqual(checkInstances(loaded), []);
  assert.match(checkInstances([{ id: "bad", source: "bugsinpy" }]).join("\n"), /unknown source/);
});

test("the CLI dry-runs without cloning, then materialises with --yes", (t) => {
  const { repo, sha } = buggyRepo(t);
  const dir = mkdtempSync(join(tmpdir(), "dt-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "instance.json");
  writeFileSync(file, JSON.stringify(instance(repo, sha)));

  const dry = spawnSync(process.execPath, [TOOL, "--instance", file, "--out", join(dir, "out")], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(dry.status, 3, dry.stderr);
  assert.match(dry.stderr, /DRY RUN/);
  assert.equal(existsSync(join(dir, "out")), false, "a dry run clones nothing");

  const real = spawnSync(
    process.execPath,
    [TOOL, "--instance", file, "--out", join(dir, "out"), "--yes"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(real.status, 0, real.stderr);
  const report = JSON.parse(real.stdout);
  assert.equal(report.materialized, 1);
  assert.equal(report.failed, 0);
  assert.ok(existsSync(report.ledger), "the ledger is written under --out");
  assert.equal(JSON.parse(readFileSync(report.ledger, "utf8").trim()).ok, true);
});

test("an instance oracle must fail at the bug and pass at the fix", (t) => {
  const { repo, buggySha, fixSha, oracle } = twoCommitRepo(t);
  const dest = join(mkdtempSync(join(tmpdir(), "dt-dest-")), "oracle-1");
  t.after(() => rmSync(dirname(dest), { recursive: true, force: true }));
  const r = materialize(
    {
      id: "oracle-1",
      source: "local",
      repo,
      commit: buggySha,
      fixCommit: fixSha,
      oracle: { command: "node dt-oracle.mjs" },
      assets: [oracle],
      expect: { goldHunks: [{ file: "calc.mjs", start: 2, end: 2 }] },
    },
    { dest },
  );
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.oracle_verified, true, "the fix commit is the oracle's receipt");
  assert.notEqual(r.oracle_at_commit, 0);
  assert.equal(r.oracle_at_fix, 0);
  assert.equal(r.repro_exit, r.oracle_at_commit, "the oracle doubles as the reproduction");
  assert.equal(r.head, buggySha, "left at the buggy revision for the arms");
});

test("refuses an oracle that passes at the buggy commit", (t) => {
  const { repo, fixSha, oracle } = twoCommitRepo(t);
  const dest = join(mkdtempSync(join(tmpdir(), "dt-dest-")), "oracle-2");
  t.after(() => rmSync(dirname(dest), { recursive: true, force: true }));
  const r = materialize(
    {
      id: "oracle-2",
      source: "local",
      repo,
      commit: fixSha,
      repro: { command: 'node -e "process.exit(1)"' },
      oracle: { command: "node dt-oracle.mjs" },
      assets: [oracle],
      expect: { goldHunks: [{ file: "calc.mjs", start: 2, end: 2 }] },
    },
    { dest },
  );
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /oracle passes at the buggy commit/);
});

test("refuses an oracle that still fails at the fix commit", (t) => {
  const { repo, buggySha, oracle } = twoCommitRepo(t);
  const dest = join(mkdtempSync(join(tmpdir(), "dt-dest-")), "oracle-3");
  t.after(() => rmSync(dirname(dest), { recursive: true, force: true }));
  const r = materialize(
    {
      id: "oracle-3",
      source: "local",
      repo,
      commit: buggySha,
      fixCommit: buggySha,
      oracle: { command: "node dt-oracle.mjs" },
      assets: [oracle],
      expect: { goldHunks: [{ file: "calc.mjs", start: 2, end: 2 }] },
    },
    { dest },
  );
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /still fails at the fix commit/);
});

test("worktree mode materialises in place, keeping the repo's dependencies", (t) => {
  const { repo, buggySha, fixSha, oracle } = twoCommitRepo(t);
  const dest = join(repo, ".dt-worktrees", "base");
  t.after(() => removeWorktree(repo, dest));
  const r = materialize(
    {
      id: "oracle-wt",
      source: "local",
      repo,
      commit: buggySha,
      fixCommit: fixSha,
      mode: "worktree",
      oracle: { command: "node dt-oracle.mjs" },
      assets: [oracle],
      expect: { goldHunks: [{ file: "calc.mjs", start: 2, end: 2 }] },
    },
    { dest },
  );
  assert.equal(r.ok, true, r.problems?.join("; "));
  assert.ok(existsSync(join(dest, "calc.mjs")), "the worktree sits inside the repo");
  removeWorktree(repo, dest);
  assert.equal(existsSync(dest), false, "the worktree is removable");
});

test("addWorktree clears a stale worktree at the same path instead of failing", (t) => {
  const { repo, buggySha } = twoCommitRepo(t);
  const dest = join(repo, ".dt-worktrees", "stale");
  t.after(() => removeWorktree(repo, dest));
  assert.deepEqual(addWorktree(repo, buggySha, dest), { ok: true });
  assert.deepEqual(
    addWorktree(repo, buggySha, dest),
    { ok: true },
    "a re-run over a stale registration still succeeds",
  );
});

test("testPatch copies the fix's test into the buggy checkout as the oracle", (t) => {
  const { repo, buggySha, fixSha } = testPatchRepo(t);
  const dest = join(mkdtempSync(join(tmpdir(), "dt-dest-")), "tp-1");
  t.after(() => rmSync(dirname(dest), { recursive: true, force: true }));
  const command = "node --test calc.test.mjs";
  const r = materialize(
    {
      id: "tp-1",
      source: "local",
      repo,
      commit: buggySha,
      fixCommit: fixSha,
      testPatch: true,
      repro: { command },
      oracle: { command },
      expect: { goldHunks: [{ file: "calc.mjs", start: 2, end: 2 }] },
    },
    { dest },
  );
  assert.equal(r.ok, true, r.problems?.join("; "));
  assert.deepEqual(r.test_patch, ["calc.test.mjs"]);
  assert.notEqual(r.repro_exit, 0, "the fix's test fails on the buggy code");
  assert.equal(r.oracle_verified, true);
});
