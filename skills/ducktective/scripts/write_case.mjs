#!/usr/bin/env node
/**
 * write_case — the store boundary, and therefore the enforcement point.
 *
 *   node skills/ducktective/scripts/write_case.mjs --file .ducktective/draft.json
 *
 * Reads a case file (JSON from --file or stdin), refuses it if it breaks the
 * schema or the hard rules, and otherwise appends it to
 * `.ducktective/cases.jsonl` plus a Markdown mirror in `.ducktective/cases/`.
 *
 * Exit codes: 0 = stored, 1 = refused (reasons on stderr), 2 = harness error.
 * A refusal is the tool working: the whole point is that a confident wrong
 * answer cannot be written down as a finding.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SCHEMA, policyViolations, repoRoot, validateSchema, writeCase } from "./lib/case-file.mjs";

const USAGE = `usage: write_case.mjs [--file CASE.json] [--repo DIR]
  --file PATH   case file to store (default: JSON on stdin)
  --repo DIR    repo that owns the store (default: nearest ancestor with .git)`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error(`unrecognised argument: ${flag}\n\n${USAGE}`);
    if (flag === "--file") opts.file = value;
    else if (flag === "--repo") opts.repo = resolve(value);
    else throw new Error(`unrecognised flag: ${flag}\n\n${USAGE}`);
  }
  return opts;
}

function readInput(opts) {
  if (opts.file) return readFileSync(opts.file, "utf8");
  if (process.stdin.isTTY) throw new Error(`no --file and no stdin\n\n${USAGE}`);
  return readFileSync(0, "utf8");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let c;
  try {
    c = JSON.parse(readInput(opts));
  } catch (err) {
    console.error(`[ducktective] not valid JSON: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const problems = [...validateSchema(c, SCHEMA), ...policyViolations(c)];
  if (problems.length) {
    console.error(`REFUSED: ${c?.id ?? "case"} cannot be recorded as a finding\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\nFix the case file or set status to "unverified" with a leading_hypothesis.`);
    process.exitCode = 1;
    return;
  }

  const repo = opts.repo ?? repoRoot();
  const stored = writeCase(c, repo);
  console.log(
    JSON.stringify(
      {
        stored: true,
        id: c.id,
        status: c.status,
        outcome: c.reproduction.outcome,
        candidates: c.candidates.length,
        ...stored,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (err) {
    console.error(`[ducktective] write_case failed: ${err.message}`);
    process.exitCode = 2;
  }
}
