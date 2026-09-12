#!/usr/bin/env node
/**
 * The skill writes snake_case; the website renders a camelCase view model. This
 * test is the seam: it reads the canonical schema and the importer together, so
 * a renamed or added field fails here instead of rendering as "undefined" on a
 * public page.
 *
 * It imports the real mapper (`site/src/lib/engine/case-import.mjs` is plain JS
 * with JSDoc types precisely so this can run it) and a real case file produced
 * by the skill's own store format.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromCaseFile, parseCasesJsonl } from "../site/src/lib/engine/case-import.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = JSON.parse(
  readFileSync(join(ROOT, "skills/ducktective/case-file.schema.json"), "utf8"),
);
const IMPORTER = readFileSync(join(ROOT, "site/src/lib/engine/case-import.mjs"), "utf8");

/** A case exactly as `write_case.mjs` would put it on disk. */
const canonical = {
  id: "DT-260912-c1fb47",
  opened_at: "2026-09-12T13:43:02.253Z",
  symptom: "total() raises IndexError on a full-length list",
  reproduction: {
    command: "python -m unittest -q test_totals",
    outcome: "reproduced",
    duration_ms: 210,
    exit_code: 1,
    runner: "unittest",
    stdout: "Ran 1 test",
    stderr: "IndexError: list index out of range",
    stack: ['File "app.py", line 7, in total'],
    covered: [{ file: "app.py", line: 7 }],
  },
  candidates: [
    {
      rank: 1,
      location: "app.py:7 total()",
      why: "appears in the failing traceback",
      hypothesis: "rows[end + 1] indexes past the end",
      check: 'python -c "from app import total; total([1,2,3,4])"',
      predicted: "fail",
      check_exit_code: 1,
      control: 'python -c "from app import total; total([1,2,3,4], 0, 2)"',
      control_exit_code: 0,
      verdict: "confirmed",
      evidence: "check: exit 1 in 128 ms\nIndexError: list index out of range",
    },
  ],
  confirmed_cause: "app.py:7 — rows[end + 1] is one past the last index",
  leading_hypothesis: null,
  confidence: "high",
  suggested_patch: null,
  status: "confirmed",
  notes: "bounded calls unaffected",
};

test("the importer names every field the schema can emit", () => {
  const missing = [];
  const walk = (/** @type {any} */ schema, /** @type {string[]} */ trail) => {
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      const name = [...trail, key].join(".");
      if (
        !IMPORTER.includes(`"${key}"`) &&
        !IMPORTER.includes(`${key}:`) &&
        !IMPORTER.includes(`.${key}`)
      ) {
        missing.push(name);
      }
      if (sub?.properties) walk(sub, [...trail, key]);
      if (sub?.items?.properties) walk(sub.items, [...trail, key]);
    }
  };
  walk(SCHEMA, []);
  assert.deepEqual(missing, [], `the website would silently drop: ${missing.join(", ")}`);
});

test("the mapped provenance is actually rendered, not just carried", () => {
  const sheet = readFileSync(join(ROOT, "site/src/components/case-file-sheet.tsx"), "utf8");
  for (const field of ["exitCode", "runner", "predicted", "checkExitCode", "controlExitCode"]) {
    assert.match(
      sheet,
      new RegExp(`reproduction\\.${field}|c\\.${field}|\\b${field}\\b`),
      `${field} is mapped but never shown`,
    );
  }
});

test("a real case file renders as a real sheet", () => {
  const { case: view, error } = fromCaseFile(canonical, "cases.jsonl");
  assert.equal(error, undefined);
  assert.equal(view?.id, canonical.id);
  assert.equal(view?.status, "confirmed");
  assert.equal(view?.confidence, "high");
  assert.equal(view?.openedAt, canonical.opened_at);
  assert.equal(view?.reproduction.durationMs, 210);
  assert.equal(view?.reproduction.outcome, "reproduced");
  assert.equal(view?.confirmedCause, canonical.confirmed_cause);
  assert.equal(view?.leadingHypothesis, undefined, 'null must not render as the string "null"');
  assert.equal(view?.candidates[0].location, "app.py:7 total()");
  assert.equal(view?.candidates[0].verdict, "confirmed");
  assert.match(view?.candidates[0].checkSource ?? "", /python -c/);
  assert.equal(view?.reproduction.covered[0].file, "app.py");
  assert.ok(view?.title?.length, "the sheet header needs a title");
});

test("every status the skill can write has a stamp", () => {
  const sheet = readFileSync(join(ROOT, "site/src/components/case-file-sheet.tsx"), "utf8");
  for (const status of SCHEMA.properties.status.enum) {
    assert.match(
      sheet,
      new RegExp(`\\b${status}\\b`),
      `case-file-sheet.tsx cannot stamp "${status}"`,
    );
  }
});

test("a broken store degrades to a message, not a blank page", () => {
  const body = [JSON.stringify(canonical), "{not json", JSON.stringify({ id: "NOPE" })].join("\n");
  const { cases, errors } = parseCasesJsonl(body, "cases.jsonl");
  assert.equal(cases.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /line 2: not JSON/);
  assert.match(errors[1], /id is not a safe filename/);
});

test("an unknown status is refused rather than rendered as an empty stamp", () => {
  const { error } = fromCaseFile({ ...canonical, status: "resolved" }, "cases.jsonl");
  assert.match(error ?? "", /status "resolved" is not one the sheet can stamp/);
});
