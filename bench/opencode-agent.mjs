#!/usr/bin/env node
/**
 * The OpenCode adapter for `bench/run.mjs`.
 *
 * The runner's contract is that the agent command writes a `claim.json` to
 * `$DT_OUT`. This wrapper turns that into an `opencode run` invocation:
 *
 *   opencode run --format json --auto [--model p/m] --file <prompt.md> "<message>"
 *
 * run with cwd = the arm's throwaway checkout, so OpenCode operates on that repo.
 * The full prompt is written to a file and attached, because on Windows the
 * `opencode` CLI is an npm `.cmd` shim that needs a shell, and a multi-line prompt
 * cannot safely ride on a shell command line. Arm A gets a bare prompt; arm B is
 * told to use the Ducktective skill. The claim is written by the agent per the
 * prompt, and if it does not write the file the wrapper falls back to the last
 * `{ file, line }` JSON object in the transcript. Token usage is summed from the
 * JSON events when present, else left null.
 *
 * Env (set by bench/run.mjs, plus these):
 *   DT_MODEL        provider/model#variant for `--model` (optional)
 *   DT_OPENCODE     the binary (default: opencode)
 *   DT_FORMAT       "json" (default) or "default"
 *   DT_AGENT_A/B    optional `--agent` per arm
 *   DT_DRY_RUN=1    print the command and exit without running OpenCode
 *
 * This is bench tooling, never shipped. It does not think; the model does.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const CLAIM_SHAPE = `{
  "file": "<repo-relative path>",
  "line": <number>,
  "cause": "<one line>",
  "reportable": true,
  "abstained": false,
  "tokens": null
}`;

/** The prompt for one arm. Arm A is bare; arm B is told to use the skill. */
export function buildPrompt({ arm, repro, out }) {
  const skill =
    arm === "B"
      ? `\nUse the Ducktective skill. Reproduce the failure first, state a hypothesis,\nrun the smallest check that could disprove it, and require a control or a\nmutation probe before you set "reportable": true. If you cannot back the\nlocation with an executed check, set "reportable": false.\n`
      : `\nDo not use any debugging skill or protocol. Work directly from the code and\nthe failing command.\n`;
  return `You are investigating a failing command in this repository.

Failing command:
  ${repro}

Find the single root cause and report it as a location, \`file:line\`, and a
one-line cause. Then write a JSON object to this exact path:

  ${out}

with this shape:
${CLAIM_SHAPE}

Set "reportable": true only if the location is backed by something you actually
ran. Do not edit any file other than the claim.
${skill}`;
}

/** The last balanced JSON object in `text` that has a string file and a line. */
export function extractClaim(text) {
  const candidates = [];
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(s.slice(i, j + 1));
            // Only a claim-shaped object: a `{file,line}` from a diff or tool
            // output must not be mistaken for the agent's answer.
            if (
              obj &&
              typeof obj.file === "string" &&
              Number.isFinite(Number(obj.line)) &&
              ("reportable" in obj || "cause" in obj || "abstained" in obj)
            )
              candidates.push(obj);
          } catch {
            /* not JSON; keep scanning */
          }
          i = j;
          break;
        }
      }
    }
  }
  return candidates.at(-1) ?? null;
}

/** Every JSON value in an OpenCode `--format json` stream, NDJSON or a document. */
export function parseEvents(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  try {
    const one = JSON.parse(text);
    return Array.isArray(one) ? one : [one];
  } catch {
    /* not a single document; try NDJSON */
  }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* a log line, not an event */
    }
  }
  return events;
}

function collectStrings(value, out) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

/** Input/output token keys an event may carry. */
const TOKEN_KEYS = new Set([
  "input",
  "output",
  "inputTokens",
  "outputTokens",
  "input_tokens",
  "output_tokens",
]);

/**
 * Total tokens from any `tokens`/`usage` object in the events, or null.
 *
 * Only known input/output keys are summed (or a provider's `total`), never every
 * numeric leaf: summing a nested `cache`/`total` would double-count metric C4.
 */
export function extractTokens(events) {
  let total = null;
  const walk = (value, key) => {
    if (!value || typeof value !== "object") return;
    if (key === "tokens" || key === "usage") {
      if (typeof value.total === "number") total = (total ?? 0) + value.total;
      else {
        const sum = Object.entries(value)
          .filter(([k, v]) => TOKEN_KEYS.has(k) && typeof v === "number")
          .reduce((acc, [, v]) => acc + v, 0);
        if (sum) total = (total ?? 0) + sum;
      }
    }
    for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  for (const e of events) walk(e, null);
  return total;
}

/** Double-quote a value for the shell; refuse quotes we cannot escape portably. */
export function shellQuote(value) {
  const s = String(value);
  if (s.includes('"')) throw new Error(`refusing a value containing a double quote: ${s}`);
  return `"${s}"`;
}

/**
 * The single shell command for one arm. One string, not an args array: the
 * message is an attached file, so nothing multi-line rides on the command line,
 * and `spawnSync(command, { shell: true })` avoids Node's DEP0190 warning.
 */
export function buildCommand({ bin, format, model, agent, promptFile }) {
  const parts = [shellQuote(bin), "run", "--format", format, "--auto"];
  if (model) {
    if (!/^[\w./#:@+-]+$/.test(model)) throw new Error(`unsafe --model value: ${model}`);
    parts.push("--model", model);
  }
  if (agent) parts.push("--agent", shellQuote(agent));
  parts.push("--file", shellQuote(promptFile));
  parts.push(
    shellQuote(
      "Read the attached file and follow its instructions exactly. Write your JSON answer to the path it names. Do not edit anything else.",
    ),
  );
  return parts.join(" ");
}

function main() {
  const arm = process.env.DT_ARM ?? "A";
  const out = process.env.DT_OUT;
  const repo = process.env.DT_REPO ?? process.cwd();
  const repro = process.env.DT_REPRO ?? "(unknown)";
  if (!out) throw new Error("DT_OUT is not set — run this through bench/run.mjs");
  const prompt = buildPrompt({ arm, repro, out });
  const promptFile = join(dirname(out), `prompt-${arm}.md`);
  const bin = process.env.DT_OPENCODE ?? "opencode";
  const agent = process.env[`DT_AGENT_${arm}`] ?? process.env.DT_AGENT;
  const command = buildCommand({
    bin,
    format: process.env.DT_FORMAT ?? "json",
    model: process.env.DT_MODEL,
    agent,
    promptFile,
  });

  if (process.env.DT_DRY_RUN === "1") {
    console.log(JSON.stringify({ cwd: repo, command, promptFile, prompt }, null, 2));
    return;
  }
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, prompt);

  const r = spawnSync(command, { cwd: repo, encoding: "utf8", windowsHide: true, shell: true });
  if (r.error) {
    console.error(`[opencode-agent] could not run ${bin}: ${r.error.message}`);
    process.exitCode = 127;
    return;
  }
  const events = parseEvents(r.stdout);
  const tokens = extractTokens(events);

  if (!existsSync(out)) {
    const claim = extractClaim(collectStrings(events, []).join("\n")) ?? extractClaim(r.stdout);
    if (claim) writeFileSync(out, JSON.stringify({ ...claim, tokens: claim.tokens ?? tokens }));
  } else if (tokens != null) {
    try {
      const claim = JSON.parse(readFileSync(out, "utf8"));
      if (claim.tokens == null) writeFileSync(out, JSON.stringify({ ...claim, tokens }));
    } catch {
      /* the agent's file is not ours to fix */
    }
  }
  process.exitCode = r.status ?? 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (err) {
    console.error(`[opencode-agent] ${err.message}`);
    process.exitCode = 2;
  }
}
