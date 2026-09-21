/**
 * The shipped corpus is data, and data drifts. This validates every instance and
 * checks the corpus is non-trivial, without cloning or running anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkInstances, loadInstances } from "./materialize.mjs";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");

test("the shipped corpus parses and every instance validates", () => {
  const instances = loadInstances(CORPUS);
  assert.ok(instances.length >= 5, `expected a real corpus, found ${instances.length}`);
  assert.deepEqual(checkInstances(instances), []);
  assert.ok(
    instances.some((i) => i.testPatch),
    "at least one test-patch instance",
  );
  assert.ok(
    instances.some((i) => i.oracle && !i.testPatch),
    "at least one host-authored oracle instance",
  );
});
