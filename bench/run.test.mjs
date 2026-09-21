/**
 * The arm runner: the env contract, the claim scoring, and one end-to-end run
 * with the stub agent. No model, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { causeHit, formatTable, makeBudget, pool, scoreClaim } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "run.mjs");

const INSTANCE = {
  id: "local-1",
  source: "local",
  repo: "",
  commit: "",
  repro: { command: "node --test calc.test.mjs" },
  expect: { goldHunks: [{ file: "calc.mjs", start: 2, end: 2 }] },
};

test("causeHit matches a gold hunk by basename and line", () => {
  const hunks = [{ file: "src/calc.mjs", start: 10, end: 12 }];
  assert.equal(causeHit(hunks, "calc.mjs", 11), true);
  assert.equal(causeHit(hunks, "/abs/src/calc.mjs", 12), true);
  assert.equal(causeHit(hunks, "calc.mjs", 9), false);
  assert.equal(causeHit(hunks, "other.mjs", 11), false);
  assert.equal(causeHit(hunks, null, 11), false);
});

test("scoreClaim turns a claim into a row; silence is an abstention", () => {
  const hit = scoreClaim(
    INSTANCE,
    "B",
    { file: "calc.mjs", line: 2, reportable: true, tokens: 5 },
    12,
  );
  assert.equal(hit.status, "ok");
  assert.equal(hit.confirmed, true);
  assert.equal(hit.cause_hit, true);
  assert.equal(hit.tokens, 5);
  assert.equal(hit.wall_ms, 12);

  const miss = scoreClaim(INSTANCE, "A", { file: "calc.mjs", line: 1, reportable: true }, 1);
  assert.equal(miss.confirmed, true);
  assert.equal(miss.cause_hit, false, "a reportable claim off the hunk is a false confirm");

  const silent = scoreClaim(INSTANCE, "A", null, 1);
  assert.equal(silent.status, "no-claim");
  assert.equal(silent.abstained, true);
  assert.equal(silent.confirmed, false);
});

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return (r.stdout ?? "").trim();
}

function buggyRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), "dt-run-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "calc.mjs"), "export function add(a, b) {\n  return a - b;\n}\n");
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

function instanceFile(t, dir, { repo, sha }) {
  const file = join(dir, "instance.json");
  writeFileSync(file, JSON.stringify({ ...INSTANCE, repo, commit: sha }));
  return file;
}

test("dry-runs without cloning, then runs both arms and scores them", (t) => {
  const { repo, sha } = buggyRepo(t);
  const dir = mkdtempSync(join(tmpdir(), "dt-run-out-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = instanceFile(t, dir, { repo, sha });
  const out = join(dir, "out");
  const baseEnv = {
    ...process.env,
    DT_STUB_CLAIM_A: "calc.mjs:1",
    DT_STUB_CLAIM_B: "calc.mjs:2",
  };

  const dry = spawnSync(
    process.execPath,
    [RUN, "--instance", file, "--agent", "stub", "--out", out],
    { encoding: "utf8", windowsHide: true, env: baseEnv },
  );
  assert.equal(dry.status, 3, dry.stderr);
  assert.match(dry.stderr, /DRY RUN/);
  assert.equal(existsSync(out), false);

  const real = spawnSync(
    process.execPath,
    [RUN, "--instance", file, "--agent", "stub", "--out", out, "--yes"],
    { encoding: "utf8", windowsHide: true, env: baseEnv, timeout: 120_000 },
  );
  assert.equal(real.status, 0, real.stderr);
  const report = JSON.parse(real.stdout);
  const rows = readFileSync(report.ledger, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.arm === "A");
  const b = rows.find((r) => r.arm === "B");
  assert.equal(a.confirmed, true);
  assert.equal(a.cause_hit, false, "arm A claimed the wrong line");
  assert.equal(b.confirmed, true);
  assert.equal(b.cause_hit, true, "arm B claimed the gold line");
  assert.equal(report.metrics.arm_A.C2_false_confirm.pct, 100);
  assert.equal(report.metrics.arm_B.C2_false_confirm.pct, 0);
});

test("an arm that writes no claim is recorded as an abstention", (t) => {
  const { repo, sha } = buggyRepo(t);
  const dir = mkdtempSync(join(tmpdir(), "dt-run-none-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = instanceFile(t, dir, { repo, sha });
  const out = join(dir, "out");
  const real = spawnSync(
    process.execPath,
    [RUN, "--instance", file, "--agent", "stub", "--arm", "A", "--out", out, "--yes"],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, DT_STUB_NONE: "1" },
      timeout: 120_000,
    },
  );
  assert.equal(real.status, 0, real.stderr);
  const report = JSON.parse(real.stdout);
  const row = JSON.parse(readFileSync(report.ledger, "utf8").trim());
  assert.equal(row.status, "no-claim");
  assert.equal(row.abstained, true);
  assert.equal(report.metrics.arm_A.C3_abstention.pct, 100);
});

test("pool bounds in-flight work and keeps input order", async () => {
  let active = 0;
  let peak = 0;
  const out = await pool([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return [n * 2];
  });
  assert.equal(peak, 2, "never more than the limit in flight");
  assert.deepEqual(out, [[2], [4], [6], [8], [10]], "results keep input order");
});

test("makeBudget exhausts on tokens and on wall clock, or not at all", () => {
  const byTokens = makeBudget({ maxTokens: 5 });
  assert.equal(byTokens.exhausted(), false);
  byTokens.tokens = 5;
  assert.equal(byTokens.exhausted(), true);
  assert.equal(makeBudget({ maxMs: 0 }).exhausted(), true);
  assert.equal(makeBudget().exhausted(), false, "no budget means no cap");
});

test("formatTable prints one row per arm, and 'no data' not 0%", () => {
  const metrics = {
    arm_A: {
      rows: 2,
      C1_cause_hit: { pct: 50 },
      C2_false_confirm: { pct: 50 },
      C3_abstention: { pct: null },
      C4_tokens: { mean: 10 },
      C5_wall_ms: { mean: 5 },
    },
  };
  const table = formatTable(metrics, ["A"]);
  assert.match(table, /arm\trows/);
  assert.match(table, /A\t2\t50%\t50%\tno data\t10\t5/);
});

test("--split selects one split, and rows carry the run identity", (t) => {
  const { repo, sha } = buggyRepo(t);
  const dir = mkdtempSync(join(tmpdir(), "dt-run-split-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const corpus = join(dir, "corpus");
  mkdirSync(corpus, { recursive: true });
  const base = { ...INSTANCE, repo, commit: sha };
  writeFileSync(join(corpus, "dev.json"), JSON.stringify({ ...base, id: "dev-1", split: "dev" }));
  writeFileSync(
    join(corpus, "held.json"),
    JSON.stringify({ ...base, id: "held-1", split: "heldout" }),
  );
  const out = join(dir, "out");
  const real = spawnSync(
    process.execPath,
    [
      RUN,
      "--instances",
      corpus,
      "--agent",
      "stub",
      "--arm",
      "A",
      "--split",
      "dev",
      "--out",
      out,
      "--yes",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, DT_STUB_CLAIM_A: "calc.mjs:2" },
      timeout: 120_000,
    },
  );
  assert.equal(real.status, 0, real.stderr);
  const report = JSON.parse(real.stdout);
  const rows = readFileSync(report.ledger, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    rows.map((r) => r.instance),
    ["dev-1"],
    "the held-out instance is untouched",
  );
  assert.equal(rows[0].split, "dev");
  assert.equal(rows[0].run, new Date().toISOString().slice(0, 10));
});

test("a token budget stops starting the next arm", (t) => {
  const { repo, sha } = buggyRepo(t);
  const dir = mkdtempSync(join(tmpdir(), "dt-run-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "instance.json");
  writeFileSync(file, JSON.stringify({ ...INSTANCE, repo, commit: sha }));
  const out = join(dir, "out");
  const real = spawnSync(
    process.execPath,
    [RUN, "--instance", file, "--agent", "stub", "--out", out, "--budget-tokens", "1", "--yes"],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        DT_STUB_CLAIM_A: "calc.mjs:2",
        DT_STUB_CLAIM_B: "calc.mjs:2",
        DT_STUB_TOKENS: "10",
      },
      timeout: 120_000,
    },
  );
  assert.equal(real.status, 0, real.stderr);
  const report = JSON.parse(real.stdout);
  const rows = readFileSync(report.ledger, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(rows.find((r) => r.arm === "A").status, "ok");
  assert.equal(rows.find((r) => r.arm === "B").status, "skipped-budget");
  assert.equal(report.budget.skipped_rows, 1);
});

test("a non-zero agent exit with no claim is a harness error, not an abstention", (t) => {
  const { repo, sha } = buggyRepo(t);
  const dir = mkdtempSync(join(tmpdir(), "dt-run-exit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "instance.json");
  writeFileSync(file, JSON.stringify({ ...INSTANCE, repo, commit: sha }));
  const out = join(dir, "out");
  const real = spawnSync(
    process.execPath,
    [
      RUN,
      "--instance",
      file,
      "--agent-cmd",
      "node -e \"console.error('boom'); process.exit(3)\"",
      "--arm",
      "A",
      "--out",
      out,
      "--yes",
    ],
    { encoding: "utf8", windowsHide: true, env: { ...process.env }, timeout: 120_000 },
  );
  assert.equal(real.status, 1, real.stderr);
  const report = JSON.parse(real.stdout);
  const row = JSON.parse(readFileSync(report.ledger, "utf8").trim());
  assert.equal(row.status, "agent-error");
  assert.equal(row.abstained, false);
  assert.equal(row.agent_exit, 3);
  assert.match(row.agent_log, /boom/);
});
