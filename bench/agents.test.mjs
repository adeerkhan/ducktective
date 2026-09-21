/**
 * The harness registry: command construction, detection, and unknown names.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HARNESSES, PREFERENCE, agentCommand, detectHarness, onPath } from "./agents.mjs";

test("an adapter is a node command ending in the harness's adapter file", () => {
  const cmd = agentCommand("opencode", "/bench");
  assert.match(cmd, /^node "/);
  assert.match(cmd, /opencode-agent\.mjs"$/);
  assert.match(agentCommand("stub", "/bench"), /stub-agent\.mjs"$/);
});

test("an unknown harness is refused, not guessed", () => {
  assert.throws(() => agentCommand("claude-code"), /unknown harness/);
});

test("every declared harness has a name, an adapter and a description", () => {
  for (const [key, h] of Object.entries(HARNESSES)) {
    assert.equal(h.name, key);
    assert.ok(h.adapter.endsWith(".mjs"));
    assert.ok(h.description.length > 0);
  }
  assert.ok(
    PREFERENCE.every((p) => p in HARNESSES),
    "preference names a known harness",
  );
});

test("detectHarness returns the first installed preference, else null", () => {
  assert.equal(
    detectHarness(() => true),
    PREFERENCE[0],
  );
  assert.equal(
    detectHarness(() => false),
    null,
  );
  const only = (bin) => bin === HARNESSES[PREFERENCE[0]].bin;
  assert.equal(detectHarness(only), PREFERENCE[0]);
});

test("onPath is false for a binary-less harness or a missing one", () => {
  assert.equal(onPath(null), false);
  assert.equal(onPath("ducktective-no-such-binary-xyz"), false);
});
