import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "./app.mjs";

// Fails: app.mjs drops the last row, so node:test reports 6 instead of 10.
test("sums every row", () => {
  assert.equal(total([1, 2, 3, 4]), 10);
});
