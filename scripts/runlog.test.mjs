#!/usr/bin/env node
/**
 * The ledger measures the product, so the ledger itself has to be measured.
 *
 * The first version parsed rows with `line[i]` — indexing characters, not
 * fields. Nothing threw: provenance came back as "r" and "c", so every count
 * printed 0 against real rows, and "0 real cases" looked like an honest finding
 * about the project rather than a bug in the instrument. These tests are the
 * difference between that number meaning something and it meaning nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRow } from "../evals/runlog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const RUNLOG = join(ROOT, "evals", "runlog.mjs");

const draft = (id, outcome, extra = {}) => ({
  id,
  opened_at: "2026-01-01T00:00:00.000Z",
  symptom: "totals drop the last row",
  reproduction: { command: "pytest -q", outcome },
  candidates: extra.candidates ?? [],
  status: outcome === "reproduced" ? "confirmed" : outcome,
  confidence: "high",
  notes: "",
});

test("parseRow keeps fields whole, including quoted commas", () => {
  assert.deepEqual(parseRow("2026-01-01,DT-1,ref/x,real,error,yes"), [
    "2026-01-01",
    "DT-1",
    "ref/x",
    "real",
    "error",
    "yes",
  ]);
  assert.deepEqual(parseRow('a,"he said ""hi"", loudly",b'), ["a", 'he said "hi", loudly', "b"]);
  const twelve = parseRow(
    readFileSync(join(ROOT, "evals", "RUNLOG.csv"), "utf8")
      .trim()
      .split("\n")[1],
  );
  assert.equal(twelve.length, 12, "the real log must parse to one field per column");
  assert.equal(twelve[3], "real", "provenance is a word, not a letter");
});

test("a recorded row is counted by report, on both sides of the provenance split", () => {
  const dir = mkdtempSync(join(tmpdir(), "dt-runlog-"));
  const csv = join(dir, "RUNLOG.csv");
  try {
    const rec = (file, provenance, repo) => {
      const casePath = join(dir, `${provenance}-${file}.json`);
      writeFileSync(casePath, JSON.stringify(draft(file, "does_not_reproduce")), "utf8");
      const r = spawnSync(
        process.execPath,
        [
          RUNLOG,
          "--csv",
          csv,
          "--record",
          "--case",
          casePath,
          "--repo",
          repo,
          "--provenance",
          provenance,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      assert.equal(r.status, 0, r.stderr);
    };
    rec("DT-real-1", "real", "/somewhere/not/mine");
    rec("DT-made-1", "made-up", "evals/cases");

    const rep = spawnSync(process.execPath, [RUNLOG, "--csv", csv, "--report"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(rep.status, 0, rep.stderr);
    assert.match(rep.stdout, /2 case\(s\): 1 real, 1 constructed/);
    assert.match(rep.stdout, /stopped correctly .*100%\s+\[2\/2\]/);
    // A row with no host numbers must say "no data", never a fabricated 0%.
    assert.match(rep.stdout, /tokens: plain "fix this" vs Ducktective\s+no data/);
    assert.ok(
      !/⚠ ZERO real cases/.test(rep.stdout),
      "one real row must clear the zero-real warning",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop-correctness fails closed when a stopped case files candidates anyway", () => {
  const dir = mkdtempSync(join(tmpdir(), "dt-runlog-"));
  const csv = join(dir, "RUNLOG.csv");
  try {
    const casePath = join(dir, "bad.json");
    writeFileSync(
      casePath,
      JSON.stringify(
        draft("DT-bad-1", "does_not_reproduce", {
          candidates: [
            {
              rank: 1,
              location: "app.py:1",
              hypothesis: "h",
              check: "c",
              verdict: "falsified",
              evidence: "e",
            },
          ],
        }),
      ),
      "utf8",
    );
    spawnSync(
      process.execPath,
      [RUNLOG, "--csv", csv, "--record", "--case", casePath, "--repo", "x", "--provenance", "real"],
      {
        windowsHide: true,
      },
    );
    const row = parseRow(readFileSync(csv, "utf8").trim().split("\n")[1]);
    assert.equal(
      row[5],
      "no",
      "candidates on a non-reproducing case is a stop failure, not a success",
    );
    const rep = spawnSync(process.execPath, [RUNLOG, "--csv", csv, "--report"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.match(rep.stdout, /stopped correctly[^\n]*0% +\[0\/1\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
