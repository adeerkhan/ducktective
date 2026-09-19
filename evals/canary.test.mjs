/**
 * The canary's mutator and scorer, plus one end-to-end run against the fixture.
 * Fast enough for `npm test`: the integration case caps itself at three mutants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyMutation,
  causeHit,
  classify,
  planMutations,
  safeRelativeFile,
  summarise,
} from "./canary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANARY = join(HERE, "canary.mjs");
const TARGET = join(HERE, "canary", "target");

const SRC = "export function f(n) {\n  // return n > 0;\n  return n > 0;\n}\n";

test("planMutations finds operators per line and skips comments", () => {
  const planned = planMutations(SRC);
  assert.deepEqual(
    planned.map((m) => [m.line, m.kind]),
    [
      [3, "throw-return"],
      [3, "gt"],
    ],
  );
});

test("applyMutation changes exactly the targeted line", () => {
  const mutated = applyMutation(SRC, { line: 3, kind: "gt" });
  assert.equal(mutated.split("\n")[2], "  return n >= 0;");
  assert.equal(mutated.split("\n")[1], "  // return n > 0;", "the comment is untouched");
  const thrown = applyMutation(SRC, planMutations(SRC)[0]);
  assert.equal(thrown.split("\n")[2], '  throw new Error("dt-canary");');
});

test("classify separates killed, survived, timeout and error", () => {
  assert.equal(classify({ code: 0 }), "survived");
  assert.equal(classify({ code: 1 }), "killed");
  assert.equal(classify({ code: null, timedOut: true }), "timeout");
  assert.equal(classify({ code: null, error: "spawn ENOENT" }), "error");
  assert.equal(classify({ code: null }), "error");
});

test("safeRelativeFile refuses a path that escapes the target", () => {
  assert.equal(safeRelativeFile("calc.mjs"), "calc.mjs");
  assert.equal(safeRelativeFile("src/calc.mjs"), "src/calc.mjs");
  for (const bad of ["../x.mjs", "a/../../b.mjs", "/abs.mjs", "C:/x.mjs", ""])
    assert.throws(() => safeRelativeFile(bad), /relative path/, `accepted ${JSON.stringify(bad)}`);
});

test("causeHit compares file basename and line of the top lead", () => {
  assert.equal(causeHit([{ location: "calc.mjs:2 add()" }], "calc.mjs", 2), true);
  assert.equal(causeHit([{ location: "./src/calc.mjs:2 add()" }], "calc.mjs", 2), true);
  assert.equal(causeHit([{ location: "calc.test.mjs:5" }], "calc.mjs", 2), false);
  assert.equal(causeHit([{ location: "calc.mjs:20" }], "calc.mjs", 2), false);
  assert.equal(causeHit([], "calc.mjs", 2), false);
});

test("summarise separates cause-hit, survivors, invalid and errored mutants", () => {
  const rows = [
    { kind: "throw-return", status: "killed", cause_hit: true },
    { kind: "throw-return", status: "killed", cause_hit: false },
    { kind: "gt", status: "killed", cause_hit: true },
    { kind: "gt", status: "survived", outcome: "does_not_reproduce" },
    { kind: "gt", status: "survived", outcome: "no-draft" },
    { kind: "lt", status: "invalid" },
    { kind: "le", status: "timeout" },
  ];
  const s = summarise(rows);
  assert.equal(s.mutants, 7);
  assert.equal(s.killed, 3);
  assert.equal(s.survived, 2);
  assert.equal(s.invalid, 1);
  assert.equal(s.errored, 1);
  assert.deepEqual(s.cause_hit, { num: 2, den: 3, pct: 67 });
  // A `no-draft` survivor has zero candidates but is not a clean non-reproduction.
  assert.deepEqual(s.survived_no_candidate, { num: 1, den: 2, pct: 50 });
  assert.deepEqual(s.byKind["throw-return"].cause_hit_rate, { num: 1, den: 2, pct: 50 });
  assert.equal(s.byKind["gt"].survived, 2);
});

test("an empty run reports 'no data', never 0%", () => {
  const s = summarise([]);
  assert.equal(s.cause_hit.pct, null);
  assert.equal(s.survived_no_candidate.pct, null);
});

test("a small end-to-end run writes a ledger of mutants", () => {
  const dir = mkdtempSync(join(tmpdir(), "dt-canary-test-"));
  try {
    const out = join(dir, "canary.jsonl");
    const r = spawnSync(
      process.execPath,
      [
        CANARY,
        "--target",
        TARGET,
        "--cmd",
        "node --test calc.test.mjs",
        "--max",
        "3",
        "--out",
        out,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 120_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /mutation canary/);
    const rows = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.ok(
        ["killed", "survived", "invalid", "timeout", "error"].includes(row.status),
        JSON.stringify(row),
      );
      assert.equal(typeof row.line, "number");
      assert.equal(row.file, "calc.mjs");
    }
    assert.ok(
      rows.some((row) => row.cause_hit === true),
      "a throwing mutant must land on its own line",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
