#!/usr/bin/env node
/**
 * The run log: one row per investigation, and the four metrics this ledger can
 * honestly hold.
 *
 *   node evals/runlog.mjs --record --case draft.json --repo /path/to/repo \
 *     --provenance real --changed-decision yes --note "why"
 *   node evals/runlog.mjs --report
 *
 * Why a file and not a conversation: the questions that decide this project are
 * counts, and counts need one row per case with that row's provenance attached.
 * Without a `real` vs `constructed` field, the ledger quietly launders the
 * author's own fixtures into evidence — the failure `ref-work.md` §8 warns about:
 * "measure on repos you don't control the selection of, and say so".
 *
 * JSONL, not CSV: every other record here is one JSON object per line, and
 * `JSON.stringify` quotes correctly for free.
 *
 * **What was cut, and why.** M5–M9 (`memory_changed_search`, `pair_case_id`,
 * `human_opened`, `tokens_*`, `wall_clock_min`, `duck_claim_right`,
 * `plain_claim_right`) are gone, and passing their flags now fails rather than
 * silently dropping data. Every one of them was a human transcribing a judgement
 * about their own run: the token counts came from a host readout a subprocess
 * cannot see, and whether the accused line was really the cause was a memory of a
 * decision made after the fix. The project's headline number was its least
 * mechanical column. Their replacement is the benchmark plan in
 * `docs/ducktective-design.md` §4 — cause-hit, false-confirm rate and cost, all
 * computed against gold hunks, with no author in the loop. `RUNLOG.jsonl` keeps
 * whatever those old rows recorded: absent fields read as empty, so history is
 * never rewritten to fit a smaller schema.
 *
 * Blank always means "nobody recorded it", never "no". A value that silently
 * became the pessimistic answer would understate the one metric design §9 rests on.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DEFAULT = join(HERE, "RUNLOG.jsonl");
let LOG = LOG_DEFAULT;

/** The row shape, in order. A key outside this list is a bug, not a column. */
const FIELDS = [
  "recorded_at",
  "case_id",
  "repo",
  "provenance", // real | constructed — who chose this bug
  "outcome", // reproduced | does_not_reproduce | error
  "stop_correct", // derived: did the gate refuse what it should refuse?
  "first_falsification_hit", // rank of the confirmed candidate, "" if none
  "survived_verify", // yes | no | not-run (M3)
  "decision_changed", // did the case file change what was done next (M4)
  "note",
];

const YES_NO = ["yes", "no"];
const PROVENANCE = ["real", "constructed"];
/** Retired with the hand-transcribed columns; named so the refusal can say why. */
const RETIRED = [
  "opened",
  "memory-changed",
  "pair-case",
  "tokens-plain",
  "tokens-duck",
  "wall-clock",
  "duck-claim",
  "plain-claim",
];

function fail(msg) {
  console.error(`[ducktective] ${msg}`);
  process.exitCode = 2;
  return null;
}

/** Strict enum: a typo must never silently become the pessimistic answer. */
function oneOf(flag, value, allowed) {
  if (value === undefined) return "";
  const v = String(value).toLowerCase();
  if (!allowed.includes(v))
    return fail(`${flag} must be one of ${allowed.join(", ")}, got "${value}"`);
  return v;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report" || a === "--record") opts.mode = a.slice(2);
    else if (a === "--csv") return fail("--csv was replaced by --log: the ledger is JSONL now");
    else if (a === "--log") LOG = resolve(argv[++i]);
    else if (a.startsWith("--")) opts[a.slice(2)] = argv[++i];
    else return fail(`unexpected argument: ${a}`);
  }
  return opts;
}

/** Everything the case file already proves, derived instead of retyped. */
function fromCase(c) {
  const outcome = c?.reproduction?.outcome ?? "";
  const confirmed = (c?.candidates ?? []).find((x) => x.verdict === "confirmed");
  const retested = (c?.candidates ?? []).find((x) => x.verified_verdict != null);
  const candidates = c?.candidates ?? [];
  return {
    case_id: c?.id ?? "",
    outcome,
    // A case that did not reproduce (or never ran) may not have filed anything.
    // A reproduced case is not judged here — that is what M2/M3 are for.
    stop_correct: outcome === "reproduced" ? "" : candidates.length === 0 ? "yes" : "no",
    first_falsification_hit: confirmed
      ? String(confirmed.rank ?? candidates.indexOf(confirmed) + 1)
      : "",
    survived_verify: retested
      ? retested.verified_verdict === retested.verdict
        ? "yes"
        : "no"
      : "not-run",
  };
}

function read() {
  if (!existsSync(LOG)) return [];
  const rows = [];
  readFileSync(LOG, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .forEach((line, i) => {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // An unreadable row stays unreadable: dropping it silently is how a
        // ledger starts lying about the record count.
        console.error(`[ducktective] ${LOG}:${i + 1}: unparseable row, skipped in counts`);
        rows.push({ _corrupt: true });
      }
    });
  return rows;
}

function record(opts) {
  if (!opts.case) return fail("--record needs --case <file.json>");
  // Flags first, the case file later: a refusal must not be able to leave a row
  // behind, so nothing that writes happens before every argument is accepted.
  for (const retired of RETIRED)
    if (opts[retired] !== undefined)
      return fail(
        `--${retired} was retired with the hand-transcribed columns; design \u00a74 moves those metrics to a mechanical benchmark rather than leave them half-filled`,
      );
  const provenance = oneOf("--provenance", opts.provenance ?? "constructed", PROVENANCE);
  const changed = oneOf("--changed-decision", opts["changed-decision"], YES_NO);
  if (provenance === null || changed === null) return;

  let c;
  try {
    c = JSON.parse(readFileSync(resolve(opts.case), "utf8"));
  } catch (err) {
    return fail(`--case is not readable JSON: ${err.message}`);
  }
  const row = {
    ...fromCase(c),
    recorded_at: new Date().toISOString().slice(0, 10),
    repo: opts.repo ?? "",
    provenance,
    decision_changed: changed,
    note: opts.note ?? "",
  };
  mkdirSync(dirname(LOG), { recursive: true });
  // A re-record replaces the row, so it may only ADD to what the first one knew:
  // re-running --record after --verify must not erase an earlier answer or file a
  // real bug as a constructed fixture.
  const prior = read().find((r) => r.case_id && r.case_id === row.case_id);
  if (prior) {
    if (opts.provenance === undefined) row.provenance = prior.provenance || row.provenance;
    for (const f of FIELDS)
      if (f !== "recorded_at" && f !== "provenance" && (row[f] ?? "") === "" && prior[f] != null)
        row[f] = prior[f];
  }
  const line = JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, row[f] ?? ""]))) + "\n";
  // One row per case id, rewritten in place — the store's own rule, for the same
  // reason: two rows for one investigation would double every metric it feeds. A
  // line this tool cannot parse is nobody's case id, so it stays.
  const kept = (existsSync(LOG) ? readFileSync(LOG, "utf8") : "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .filter((l) => {
      try {
        return !row.case_id || JSON.parse(l).case_id !== row.case_id;
      } catch {
        return true;
      }
    })
    .join("\n");
  writeFileSync(LOG, (kept ? kept + "\n" : "") + line, "utf8");
  console.log(
    JSON.stringify(
      {
        recorded: row.case_id || "(blank id)",
        provenance: row.provenance,
        outcome: row.outcome,
        log: LOG,
      },
      null,
      2,
    ),
  );
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "no data");

/** Per group, so a constructed fixture never shares a denominator with someone else's bug. */
function summarise(g) {
  const answered = (f, ok = (v) => Boolean(v)) => g.filter((r) => ok(r[f]));
  const yes = (f) => answered(f, (v) => v === "yes").length;
  const stops = answered("outcome", (v) => v === "does_not_reproduce" || v === "error");
  const repro = answered("outcome", (v) => v === "reproduced");
  const ranks = repro
    .map((r) => Number(r.first_falsification_hit))
    .filter((n) => Number.isInteger(n) && n > 0);
  const firstHit = ranks.filter((n) => n === 1).length;
  // \u00a79's continue-branch threshold is "first or second candidate", so the rank<=2
  // share is printed next to the rank-1 share: a metric that measures a different
  // sentence than the one the decision cites gets ignored quietly.
  const withinTwo = ranks.filter((n) => n <= 2).length;
  const retested = answered("survived_verify", (v) => v && v !== "not-run");
  const decisions = answered("decision_changed");
  const line = (id, label, value) => `  ${id.padStart(3)}. ${label.padEnd(44)} ${value}`;
  const row = (id, label, num, den) =>
    line(id, label, den ? `${pct(num, den)}  [${num}/${den}]` : "no data");
  return [
    row("M1", "stopped correctly (stale + broken)", yes("stop_correct"), stops.length),
    line(
      "M2",
      "confirmed on the FIRST candidate",
      repro.length
        ? `${pct(firstHit, repro.length)}  [${firstHit}/${repro.length}]  rank\u22642: ${withinTwo}`
        : "no data",
    ),
    row("M3", "claim survived --verify", yes("survived_verify"), retested.length),
    row("M4", "case file CHANGED a decision", yes("decision_changed"), decisions.length),
  ];
}
function report() {
  const rows = read().filter((r) => !r._corrupt);
  const real = rows.filter((r) => r.provenance === "real");
  const blocks = [["all rows", rows]];
  // The real subset prints only when it exists AND differs from `all`, otherwise
  // the same numbers appear twice and read as two findings.
  if (real.length && real.length !== rows.length) blocks.push(["real rows only", real]);
  console.log(
    `Ducktective run log \u2014 ${rows.length} row(s): ${real.length} real, ${rows.length - real.length} constructed\n`,
  );
  for (const [label, g] of blocks) {
    console.log(`  [${label}: ${g.length}]`);
    console.log(summarise(g).join("\n"));
    console.log("");
  }
  console.log(
    "  Four metrics, three derived from the case file itself. M4 is the only one that\n" +
      "  asks a human, and the decision does not rest on it: design v2 \u00a74 replaces the\n" +
      "  field study with a corpus that has known answers, so the case for this project\n" +
      "  has to come from a stranger's bugs and a mechanical table, not from the author's\n" +
      "  memory of his own runs.",
  );
  if (!real.length)
    console.log(
      "\n  \u26a0 ZERO real rows. Nothing here measures the product; it measures fixtures.\n" +
        "    Design v2 \u00a74 is the work: a corpus with known answers, two arms run by an\n" +
        "    agent rather than an author, and metrics computed from them.",
    );
  process.exitCode = 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts) {
    if (opts.mode === "record") record(opts);
    else if (opts.mode === "report") report();
    else
      console.log(
        "usage:\n  node evals/runlog.mjs [--log PATH] --record --case draft.json --repo PATH \\\n" +
          "    [--provenance real|constructed] [--changed-decision yes|no] [--note TEXT]\n" +
          "  node evals/runlog.mjs [--log PATH] --report",
      );
  }
}
