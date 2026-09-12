/**
 * The CLI, not the lib: `write_case.mjs` is what a host agent actually runs, so
 * its exit codes and stderr are the interface under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITE_CASE = join(HERE, "..", "scripts", "write_case.mjs");

const caseFile = {
  id: "DT-260101-01",
  opened_at: "2026-01-01T00:00:00.000Z",
  symptom: "totals drop the last row",
  reproduction: {
    command: "python -m unittest -q",
    outcome: "reproduced",
    exit_code: 1,
    duration_ms: 12,
  },
  candidates: [
    {
      rank: 1,
      location: "app.py:7 total()",
      why: "in the failing traceback",
      hypothesis: "rows[end + 1] indexes past the end when end defaults to len(rows) - 1",
      check: 'python -c "from app import total; total([1,2,3,4])"',
      predicted: "fail",
      check_exit_code: 1,
      verdict: "confirmed",
      evidence: "IndexError: list index out of range",
    },
  ],
  confirmed_cause: "end + 1 is one past the last index",
  confidence: "high",
  status: "confirmed",
  notes: "",
};

function store(c, repo) {
  const file = join(repo, "case.json");
  writeFileSync(file, JSON.stringify(c), "utf8");
  return spawnSync(process.execPath, [WRITE_CASE, "--file", file, "--repo", repo], {
    encoding: "utf8",
    windowsHide: true,
  });
}

test("a case with real evidence is stored, and the run reports where", () => {
  const repo = mkdtempSync(join(tmpdir(), "dt-cli-"));
  try {
    const run = store(caseFile, repo);
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.stored, true);
    assert.equal(out.id, "DT-260101-01");
    assert.ok(existsSync(out.markdown), "the Markdown mirror must exist");
    assert.match(readFileSync(join(repo, ".ducktective", "cases.jsonl"), "utf8"), /DT-260101-01/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a speculative case exits 1 and says which rule it broke", () => {
  const repo = mkdtempSync(join(tmpdir(), "dt-cli-"));
  try {
    const run = store(
      { ...caseFile, candidates: [{ ...caseFile.candidates[0], evidence: "" }] },
      repo,
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^REFUSED/m);
    assert.match(run.stderr, /no captured output/);
    assert.ok(!existsSync(join(repo, ".ducktective")), "a refused case must not touch the store");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an unknown field is refused rather than silently dropped", () => {
  const repo = mkdtempSync(join(tmpdir(), "dt-cli-"));
  try {
    const run = store({ ...caseFile, confidance: "high" }, repo);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /unknown property "confidance"/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("input that is not JSON is a harness error (2), not a refusal (1)", () => {
  const repo = mkdtempSync(join(tmpdir(), "dt-cli-"));
  try {
    const file = join(repo, "case.json");
    writeFileSync(file, "{not json", "utf8");
    const run = spawnSync(process.execPath, [WRITE_CASE, "--file", file, "--repo", repo], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /not valid JSON/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
