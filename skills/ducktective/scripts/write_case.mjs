#!/usr/bin/env node
/**
 * write_case — the store boundary, and therefore the enforcement point.
 *
 *   node skills/ducktective/scripts/write_case.mjs --file .ducktective/draft.json
 *   node skills/ducktective/scripts/write_case.mjs --causes
 *
 * Reads a case file (JSON from --file or stdin), refuses it if it breaks the
 * schema or the hard rules, and otherwise appends it to
 * `.ducktective/cases.jsonl` plus a Markdown mirror in `.ducktective/cases/`.
 * It also upserts the case's root cause in `.ducktective/causes.jsonl`, so a
 * repeated cause becomes a recurrence count instead of a near-duplicate row.
 *
 * `--causes` prints that index, most recurrent first — the preventative read.
 *
 * Exit codes: 0 = stored, 1 = refused (reasons on stderr), 2 = harness error.
 * A refusal is the tool working: the whole point is that a confident wrong
 * answer cannot be written down as a finding.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SCHEMA,
  listCauses,
  policyViolations,
  repoRoot,
  validateSchema,
  writeCase,
} from "./lib/case-file.mjs";
import { blindOverturn, caseReportability, whyViolations } from "./lib/verdict-policy.mjs";

const USAGE = `usage: write_case.mjs [--file CASE.json] [--repo DIR]
  --file PATH     case file to store (default: JSON on stdin)
  --repo DIR      repo that owns the store (default: nearest ancestor with .git)
  --causes        print the recurrence index (distinct root causes, most seen first)`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--causes") {
      opts.causes = true;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      opts.help = true;
      continue;
    }
    const value = argv[++i];
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
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const repo = opts.repo ?? repoRoot();

  if (opts.causes) {
    console.log(JSON.stringify({ causes: listCauses(repo) }, null, 2));
    return;
  }

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

  const stored = writeCase(c, repo);
  const report = caseReportability(c);
  const why = whyViolations(c);
  console.log(
    JSON.stringify(
      {
        stored: true,
        id: c.id,
        status: c.status,
        outcome: c.reproduction.outcome,
        candidates: c.candidates.length,
        reportable: report.reportable,
        cause_confidence: report.confidence,
        not_reportable: report.reason || null,
        why_violations: why,
        blind_overturn: blindOverturn(c),
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
