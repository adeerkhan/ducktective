import { test } from "node:test";
import assert from "node:assert/strict";
import { add, isPositive, max, clamp } from "./calc.mjs";

test("add sums its arguments", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test("isPositive is false at zero", () => {
  assert.equal(isPositive(1), true);
  assert.equal(isPositive(0), false);
});

test("max returns the greater value", () => {
  assert.equal(max(2, 3), 3);
  assert.equal(max(5, 1), 5);
});

test("clamp keeps values inside the bounds", () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});
