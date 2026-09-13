#!/usr/bin/env node
/**
 * The run log: turns real investigations into the design doc's four numbers.
 *
 *   node evals/runlog.mjs --record --case draft.json --repo /path/to/repo \
 *     --provenance real --tokens-plain 4200 --tokens-duck 1500 --opened yes
 *   node evals/runlog.mjs --report
 *
 * Why a file and not a conversation: the metrics that decide this project
 * (`docs/ref-work.md` §8 — "does anyone open the case file"; design doc L163 —
 * "stop on non-reproducing symptoms, near 100%") are counts, and counts need a
 * row per case with the provenance of that case attached. Without a column for
 * `constructed` vs `real`, the ledger quietly launders my own fixtures into
 * evidence — which is the exact failure `ref-work.md` §8 warns about:
 * "measure on repos you don't control the selection of, and say so."
 *
 * Two columns are host-reported and cannot be measured from a shell: the token
 * counts (they belong to the model that ran) and whether a human opened the
 * Markdown. They are asked for, not guessed at, and blank is a legal answer —
 * `--report` counts what is missing instead of pretending.
 */
import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSV_DEFAULT = join(HERE, "RUNLOG.csv");
/** Overridable so the ledger itself can be tested without touching the real log. */
let CSV = CSV_DEFAULT;
const HEADER = [
  "recorded_at",
  "case_id",
  "repo",
  "provenance", // real | constructed — who chose this bug
  "outcome", // reproduced | does_not_reproduce | error
  "stop_correct", // did the gate refuse to investigate what it should refuse?
  "first_falsification_hit", // rank of the confirmed candidate, "" if none
  "survived_verify", // yes | no | not-run (design doc metric #2)
  "tokens_plain", // host-reported
  "tokens_duck", // host-reported
  "human_opened", // yes | no | "" (ref-work §8: only matters if someone reads it)
  "note",
].join(",");

const FIELDS = HEADER.split(",");

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report" || a === "--record") opts.mode = a.slice(2);
    else if (a === "--csv") CSV = resolve(argv[++i]);
    else if (a.startsWith("--")) opts[a.slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${a}`);
  }
  return opts;
}

const yes = (v) =>
  ["yes", "y", "true"].includes(String(v).toLowerCase())
    ? "yes"
    : v == null || v === ""
      ? ""
      : "no";

/** Derive everything a case file already knows, from the case file. */
function fromCase(c, { provenance, repo }) {
  const outcome = c?.reproduction?.outcome ?? "";
  const confirmed = (c?.candidates ?? []).find((x) => x.verdict === "confirmed");
  const verified = (c?.candidates ?? []).find((x) => x.verified_verdict);
  return {
    case_id: c?.id ?? "",
    repo,
    provenance: provenance === "real" ? "real" : "constructed",
    outcome,
    // Metric #1 generalised: correct = refused to investigate (no candidates
    // filed as findings) OR reproduced and reached a verdict. A stale ticket
    // that produced a confident theory is a stop failure.
    stop_correct:
      outcome === "reproduced"
        ? "yes"
        : outcome === "does_not_reproduce" || outcome === "error"
          ? (c?.candidates ?? []).length === 0
            ? "yes"
            : "no"
          : "",
    first_falsification_hit: confirmed
      ? String(confirmed.rank ?? c.candidates.indexOf(confirmed) + 1)
      : "",
    survived_verify: verified
      ? verified.verified_verdict === verified.verdict
        ? "yes"
        : "no"
      : "not-run",
  };
}

function read() {
  if (!existsSync(CSV)) return { header: FIELDS, rows: [] };
  const [head, ...body] = readFileSync(CSV, "utf8").trim().split("\n");
  const cols = head.split(",");
  return {
    header: cols,
    rows: body
      .filter(Boolean)
      .map((line) => Object.fromEntries(cols.map((c, i) => [c, parseRow(line)[i] ?? ""]))),
  };
}

const esc = (v) =>
  /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v ?? "");

/**
 * Split one CSV row into fields, honouring quoted values and doubled quotes.
 *
 * This replaced `line[i]`, which indexed the row's CHARACTERS: every column came
 * back as one letter, the counts printed 0, and nothing threw. A ledger that
 * silently reports "no data" while real rows sit in the file is worse than one
 * that crashes, because "0 real cases" reads like a finding instead of a bug.
 */
export function parseRow(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function record(opts) {
  if (!opts.case) throw new Error("--record needs --case <file.json>");
  const c = JSON.parse(readFileSync(resolve(opts.case), "utf8"));
  const row = {
    ...fromCase(c, { provenance: opts.provenance, repo: opts.repo ?? "" }),
    recorded_at: new Date().toISOString().slice(0, 10),
    tokens_plain: opts["tokens-plain"] ?? "",
    tokens_duck: opts["tokens-duck"] ?? "",
    human_opened: yes(opts.opened),
    note: (opts.note ?? "").replaceAll(",", ";"),
  };
  const { header, rows } = read();
  mkdirSync(HERE, { recursive: true });
  if (!existsSync(CSV)) writeFileSync(CSV, header.join(",") + "\n", "utf8");
  appendFileSync(CSV, header.map((f) => esc(row[f])).join(",") + "\n", "utf8");
  console.log(
    JSON.stringify(
      { recorded: row.case_id || "(blank id)", row, total_rows: rows.length + 1, csv: CSV },
      null,
      2,
    ),
  );
}

const num = (v) => (v === "" || v == null ? null : Number(v));
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "no data");

function report() {
  const { rows } = read();
  const real = rows.filter((r) => r.provenance === "real");
  const constructed = rows.filter((r) => r.provenance === "constructed");
  const stops = rows.filter((r) => r.outcome === "does_not_reproduce" || r.outcome === "error");
  const stopped = stops.filter((r) => r.stop_correct === "yes");
  const repro = rows.filter((r) => r.outcome === "reproduced");
  const hit1 = repro.filter((r) => r.first_falsification_hit === "1");
  const verified = rows.filter((r) => r.survived_verify !== "not-run" && r.survived_verify !== "");
  const survived = verified.filter((r) => r.survived_verify === "yes");
  const opened = rows.filter((r) => r.human_opened);
  const kept = opened.filter((r) => r.human_opened === "yes");
  const tp = rows.map((r) => num(r.tokens_plain)).filter((n) => Number.isFinite(n));
  const td = rows.map((r) => num(r.tokens_duck)).filter((n) => Number.isFinite(n));
  const ratio =
    tp.length && td.length && tp.length === td.length
      ? `${(tp.reduce((a, b) => a + b, 0) / td.reduce((a, b) => a + b, 0)).toFixed(2)}×`
      : "no data";

  console.log(`
Ducktective run log — ${rows.length} case(s): ${real.length} real, ${constructed.length} constructed
(the constructed/real split is the point: only the real column is evidence about
repos nobody chose for me, per docs/ref-work.md §8)

  1. stopped correctly on non-reproducing / broken commands   ${pct(stopped.length, stops.length)}  [${stopped.length}/${stops.length}]
  2. confirmed on the FIRST falsification                     ${pct(hit1.length, repro.length)}  [${hit1.length}/${repro.length} reproduced]
  3. survived --verify re-execution                           ${pct(survived.length, verified.length)}  [${survived.length}/${verified.length} re-tested]
  4. case file opened by a human                              ${pct(kept.length, opened.length)}  [${kept.length}/${opened.length} answered; ${rows.length - opened.length} blank]
  5. tokens: plain "fix this" vs Ducktective                  ${ratio}  [${tp.length}/${rows.length} rows have both numbers]
`);
  const realStops = stops.filter((r) => r.provenance === "real");
  if (realStops.length)
    console.log(
      `   real-repo subset of (1): ${pct(realStops.filter((r) => r.stop_correct === "yes").length, realStops.length)} [${realStops.filter((r) => r.stop_correct === "yes").length}/${realStops.length}]\n`,
    );
  if (!real.length)
    console.log(
      "   ⚠ ZERO real cases. Nothing here measures the product; it measures my\n" +
        "     fixtures. Days 11–12 of the plan are not done until rows with\n" +
        "     provenance=real exist.\n",
    );
  if (!opened.length)
    console.log(
      "   ⚠ no human_opened answers yet — the ref-work §8 risk is untested, not disproved.\n",
    );
  process.exitCode = 0;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.mode === "record") record(opts);
else if (opts.mode === "report") report();
else
  console.log(
    `usage:\n  node evals/runlog.mjs --record --case draft.json --repo PATH [--provenance real] [--tokens-plain N --tokens-duck N --opened yes]\n  node evals/runlog.mjs --report`,
  );
