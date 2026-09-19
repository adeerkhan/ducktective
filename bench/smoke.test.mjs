/**
 * The benchmark capture path, tested before it has ever seen a real row.
 *
 * These tests do not measure Ducktective. They prove the spec validation, the
 * content-addressed identity, and the C1..C12 arithmetic are correct, so the
 * first real run is a measurement rather than a debugging session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCES, jobId, validateInputs, validateInstance } from "./sources.mjs";
import { computeMetrics, rate } from "./report.mjs";

test("validateInputs rejects unknown and missing, accepts declared", () => {
  assert.deepEqual(validateInputs("local", { path: "/tmp/x" }), { path: "/tmp/x" });
  assert.throws(() => validateInputs("local", {}), /missing required parameter/);
  assert.throws(() => validateInputs("local", { path: "x", colour: "red" }), /unknown parameter/);
  assert.throws(() => validateInputs("nope", {}), /unknown source/);
  // A source with no materialiser is not declared at all.
  assert.throws(() => validateInputs("bugsinpy", { project: "tqdm", bug: "1" }), /unknown source/);
});

test("a job id is stable across input order and distinct across inputs", () => {
  const a = jobId("local", { path: "/a", tag: "x" });
  const b = jobId("local", { tag: "x", path: "/a" });
  assert.equal(a, b, "key order must not change the identity");
  assert.notEqual(a, jobId("local", { path: "/b", tag: "x" }));
  assert.notEqual(a, jobId("other", { path: "/a", tag: "x" }));
});

test("every declared source has a name, a description, and declared params", () => {
  for (const [key, source] of Object.entries(SOURCES)) {
    assert.equal(source.name, key);
    assert.ok(source.description.length > 0);
    assert.ok(Array.isArray(source.params));
    assert.equal(typeof source.implemented, "boolean");
  }
});

const INSTANCE = {
  id: "local-demo-1",
  source: "local",
  repo: "/tmp/demo",
  repro: { command: "python -m pytest -q" },
  expect: { goldHunks: [{ file: "app.py", start: 6, end: 8 }] },
};

test("an instance spec must name a repro and a gold hunk", () => {
  assert.deepEqual(validateInstance(INSTANCE), []);
  assert.match(validateInstance({ ...INSTANCE, id: "" }).join("\n"), /missing "id"/);
  assert.match(validateInstance({ ...INSTANCE, source: "bugsinpy" }).join("\n"), /unknown source/);
  assert.match(validateInstance({ ...INSTANCE, repro: {} }).join("\n"), /repro needs a "command"/);
  assert.match(
    validateInstance({ ...INSTANCE, expect: { goldHunks: [] } }).join("\n"),
    /non-empty/,
  );
  assert.match(
    validateInstance({ ...INSTANCE, expect: { goldHunks: [{ file: "a" }] } }).join("\n"),
    /must be \{file, start, end\}/,
  );
});

test("rate says 'no data' on an empty denominator, never 0%", () => {
  assert.deepEqual(rate(0, 0), { num: 0, den: 0, pct: null });
  assert.equal(rate(1, 4).pct, 25);
});

test("C2 is confirmed-but-missing-gold, and C1 is confirmed-and-hit", () => {
  const rows = [
    {
      instance: "i1",
      arm: "bare",
      confirmed: true,
      cause_hit: true,
      tokens: 100,
      wall_ms: 10,
      cause_hash: "a",
    },
    {
      instance: "i1",
      arm: "skill",
      confirmed: true,
      cause_hit: true,
      tokens: 200,
      wall_ms: 20,
      cause_hash: "a",
    },
    {
      instance: "i2",
      arm: "bare",
      confirmed: true,
      cause_hit: false,
      tokens: 100,
      wall_ms: 10,
      cause_hash: "b",
    },
    {
      instance: "i2",
      arm: "skill",
      confirmed: false,
      abstained: true,
      tokens: 150,
      wall_ms: 15,
      cause_hash: "",
    },
  ];
  const skill = computeMetrics(rows.filter((r) => r.arm === "skill"));
  assert.equal(skill.C1_cause_hit.pct, 50);
  assert.equal(skill.C2_false_confirm.pct, 0, "the skill arm did not false-confirm here");
  assert.equal(skill.C3_abstention.pct, 50);
  assert.equal(skill.C4_tokens.mean, 175);
  assert.equal(skill.C12_distinct_causes.value, 1);

  const bare = computeMetrics(rows.filter((r) => r.arm === "bare"));
  assert.equal(bare.C2_false_confirm.pct, 50, "one of two bare confirmations missed gold");
});

test("the ladder metrics have honest empty-denominator behaviour", () => {
  const m = computeMetrics([
    { instance: "i", arm: "skill", confirmed: false, abstained: true, tokens: 1, wall_ms: 1 },
  ]);
  assert.equal(m.C6_bisect_yield.pct, 0, "one row, no save found: 0% not no-data");
  assert.equal(m.C7_probe_kill.pct, null);
  assert.equal(m.C8_blind_overturn.pct, null, "no row reached the blind checker: no data");
  assert.equal(m.C9_why_consistency.pct, 0, "one row, no E5 violation");
  assert.equal(m.C10_replication_survival.pct, null);
  assert.equal(m.C11_closure_yield.pct, null);
});
