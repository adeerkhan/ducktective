import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { overlap, rank, tokenize } from "../scripts/query_memory.mjs";
import { writeCase } from "../scripts/lib/case-file.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "scripts", "query_memory.mjs");

const mkCase = (id, symptom, extra = {}) => ({
  id,
  opened_at: `${extra.day ?? "2026-01-0"}1T00:00:00.000Z`,
  symptom,
  reproduction: { command: "python -m unittest -q", outcome: "reproduced" },
  candidates: [
    {
      location: extra.location ?? "app.py:7 total()",
      hypothesis: "h",
      check: "c",
      verdict: "pending",
      evidence: "",
    },
  ],
  confirmed_cause: extra.cause ?? null,
  leading_hypothesis: null,
  confidence: "none",
  suggested_patch: null,
  status: extra.status ?? "confirmed",
  notes: "",
});

function repoWith(t, cases) {
  const repo = mkdtempSync(join(tmpdir(), "dt-mem-"));
  for (const c of cases) writeCase(c, repo);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  return repo;
}

function tool(args, cwd) {
  const run = spawnSync(process.execPath, [TOOL, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

const totals = mkCase("DT-260101-aa", "total() raises IndexError on a full-length list", {
  cause: "rows[end + 1] is one past the last index",
});
const auth = mkCase("DT-260102-bb", "session cookie is dropped on redirect to the login page", {
  location: "auth.py:41 signIn()",
  day: "2",
});
const unrelated = mkCase("DT-260103-cc", "docker build fails on a missing layer cache", {
  location: "Dockerfile:3",
  day: "3",
});

test("the nearest past case leads, and the unrelated one never shows up", (t) => {
  const repo = repoWith(t, [auth, totals, unrelated]);
  const { code, out } = tool(
    ["--symptom", "IndexError from total() on a full list of rows", "--repo", repo],
    repo,
  );
  assert.equal(code, 0);
  assert.match(out, /Rap sheet — 1 of 3 cases/);
  assert.match(out, /DT-260101-aa/);
  assert.ok(!out.includes("DT-260103-cc"), "a docker-cache case is not a memory of this bug");
  assert.match(out, /rows\[end \+ 1\]/, "the old finding travels with the row");
});

test("--top and --min tighten the list", (t) => {
  const repo = repoWith(t, [auth, totals, unrelated]);
  const all = tool(
    [
      "--symptom",
      "total list index error cookie redirect docker cache",
      "--repo",
      repo,
      "--min",
      "0",
      "--top",
      "3",
    ],
    repo,
  );
  assert.match(all.out, /3 of 3/);
  const one = tool(
    [
      "--symptom",
      "total list index error cookie redirect docker cache",
      "--repo",
      repo,
      "--min",
      "0",
      "--top",
      "1",
    ],
    repo,
  );
  assert.match(one.out, /Rap sheet — 1 of 3/);
  const strict = tool(["--symptom", "cookie redirect", "--repo", repo, "--min", "0.5"], repo);
  assert.match(strict.out, /Treat it as new/);
});

test("a case does not recommend itself", (t) => {
  const repo = repoWith(t, [totals]);
  const draft = join(repo, "draft.json");
  writeFileSync(draft, JSON.stringify({ ...totals, id: "DT-260101-aa" }), "utf8");
  const { out } = tool(["--symptom", totals.symptom, "--repo", repo, "--file", draft], repo);
  assert.match(out, /Treat it as new/);
});

test("an empty store is a normal day, not an error", (t) => {
  const repo = repoWith(t, []);
  const { code, out } = tool(["--symptom", "anything", "--repo", repo], repo);
  assert.equal(code, 0);
  assert.match(out, /first case file starts here/);
});

test("--json is parseable and carries the score", (t) => {
  const repo = repoWith(t, [totals, auth]);
  const { code, out } = tool(["--symptom", "total() IndexError", "--repo", repo, "--json"], repo);
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.cases, 2);
  assert.equal(parsed.hits[0].id, "DT-260101-aa");
  assert.ok(parsed.hits[0].score > 0.1, `expected a real overlap, got ${parsed.hits[0].score}`);
});

test("bad arguments are an error, missing --symptom is caught early", () => {
  const { code, err } = tool([], process.cwd());
  assert.equal(code, 2);
  assert.match(err, /--symptom and\/or --locations/);
  assert.equal(tool(["--symptom", "x", "--min", "9"], process.cwd()).code, 2);
});

// --- the ranking itself, no subprocess --------------------------------------

test("tokenize keeps code-shaped tokens; no stopwords, same as the site", () => {
  assert.deepEqual(
    [...tokenize("total() throws on row 7 — the api")],
    ["total", "throws", "row", "the", "api"],
  );
  assert.deepEqual([...tokenize("")], []);
  assert.equal(overlap(tokenize("app.py:7"), tokenize("app.py:7")), 1);
  assert.equal(overlap(tokenize("aardvark"), tokenize("zebra")), 0);
});

test("rank sorts by overlap, then newest first, and honours the floor", () => {
  const hits = rank("total index error", [totals, auth, unrelated], { top: 3, min: 0 });
  assert.deepEqual(
    hits.map((h) => h.case.id),
    ["DT-260101-aa", "DT-260103-cc", "DT-260102-bb"],
  );
  assert.ok(hits[0].score > hits[1].score);
  assert.deepEqual(
    rank("total index error", [totals], { top: 3, min: 0.99, excludeId: "DT-260101-aa" }),
    [],
  );
});
