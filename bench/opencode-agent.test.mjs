/**
 * The OpenCode adapter: the prompt it builds, the claim/token parsing, and the
 * dry-run command. No model and no network — the real call is a separate run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCommand,
  buildPrompt,
  extractClaim,
  extractTokens,
  parseEvents,
  shellQuote,
} from "./opencode-agent.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, "opencode-agent.mjs");

test("arm A is bare and arm B is told to use the skill", () => {
  const a = buildPrompt({ arm: "A", repro: "node --test calc.test.mjs", out: "/tmp/claim.json" });
  const b = buildPrompt({ arm: "B", repro: "node --test calc.test.mjs", out: "/tmp/claim.json" });
  assert.doesNotMatch(a, /Ducktective/);
  assert.match(a, /Do not use any debugging skill/);
  assert.match(b, /Ducktective skill/);
  assert.match(b, /mutation probe/);
  for (const p of [a, b]) {
    assert.match(p, /node --test calc\.test\.mjs/);
    assert.match(p, /\/tmp\/claim\.json/);
  }
});

test("extractClaim takes the last file:line JSON object, ignoring noise", () => {
  const text = [
    'the model said {"not": "a claim"} then',
    '```json\n{ "file": "src/a.mjs", "line": 1, "reportable": false }\n```',
    'and finally { "file": "src/calc.mjs", "line": 2, "reportable": true }',
  ].join("\n");
  const claim = extractClaim(text);
  assert.equal(claim.file, "src/calc.mjs");
  assert.equal(claim.line, 2);
  assert.equal(extractClaim("no json here"), null);
  assert.equal(
    extractClaim('{ "file": "src/x.mjs", "line": 3 }'),
    null,
    "a bare file:line from tool output is not the agent's claim",
  );
});

test("parseEvents reads a document, NDJSON, or neither", () => {
  assert.deepEqual(parseEvents('{"a":1}'), [{ a: 1 }]);
  assert.deepEqual(parseEvents('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseEvents('{"a":1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseEvents("plain log line\n"), []);
  assert.deepEqual(parseEvents(""), []);
});

test("extractTokens sums usage, or says no data", () => {
  assert.equal(
    extractTokens([{ type: "step", usage: { input: 100, output: 20 } }, { usage: { input: 5 } }]),
    125,
  );
  assert.equal(
    extractTokens([{ usage: { input: 100, output: 20, cache: { read: 5, write: 2 } } }]),
    120,
    "nested cache fields are not billed tokens",
  );
  assert.equal(extractTokens([{ usage: { total: 200, input: 100, output: 20 } }]), 200);
  assert.equal(extractTokens([{ type: "text", text: "hi" }]), null);
  assert.equal(extractTokens([]), null);
});

test("the command is one shell-safe line with the prompt attached as a file", () => {
  const command = buildCommand({
    bin: "opencode",
    format: "json",
    model: "opencode/gpt-5",
    promptFile: "/tmp/prompt-B.md",
  });
  assert.match(command, /^"opencode" run --format json --auto/);
  assert.match(command, /--model opencode\/gpt-5/);
  assert.match(command, /--file "\/tmp\/prompt-B\.md"/);
  assert.ok(!command.includes("\n"), "a multi-line prompt must not ride on the command line");
  assert.doesNotMatch(command, /Ducktective/);
});

test("a model or agent value cannot inject a shell command", () => {
  assert.throws(
    () => buildCommand({ bin: "opencode", format: "json", model: "a; rm -rf /", promptFile: "/p" }),
    /unsafe --model/,
  );
  assert.throws(() => shellQuote('a"b'), /double quote/);
});

test("dry run prints the exact opencode command without running it", () => {
  const dir = mkdtempSync(join(tmpdir(), "dt-oc-"));
  try {
    const r = spawnSync(process.execPath, [AGENT], {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        DT_ARM: "B",
        DT_REPRO: "node --test calc.test.mjs",
        DT_OUT: join(dir, "claim.json"),
        DT_REPO: dir,
        DT_MODEL: "opencode/gpt-5",
        DT_DRY_RUN: "1",
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.match(plan.command, /^"opencode" run --format json --auto/);
    assert.match(plan.command, /--model opencode\/gpt-5/);
    assert.ok(plan.command.includes(`--file "${plan.promptFile}"`));
    assert.match(plan.promptFile, /prompt-B\.md$/);
    assert.match(plan.prompt, /Ducktective skill/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
