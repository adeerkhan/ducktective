import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "./totals.mjs";

test("counts every row", () => {
  assert.equal(total([1, 2, 3, 4]), 10);
});
