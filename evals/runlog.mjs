#!/usr/bin/env node
/**
 * The run log: turns real investigations into the design doc's metrics.
 *
 *   node evals/runlog.mjs --record --case draft.json --repo /path/to/repo \
 *     --provenance real --tokens-plain 4200 --tokens-duck 1500 \
 *     --opened yes --changed-decision yes --memory-changed n/a --wall-clock 9
 *   node evals/runlog.mjs --report
 *
 * Why a file and not a conversation: the metrics that decide this project
 * (`ref-work.md` §8 — "does anyone open the case file"; design §8.3, where M1–M7 are
 * defined) are counts,
 * and counts need one row per case with that row's provenance attached. Without
 * a `real` vs `constructed` field, the ledger quietly launders my own fixtures
 * into evidence, which is the exact failure §8 warns about: "measure on repos you
 * don't control the selection of, and say so".
 *
 * JSONL, not CSV: the repo already keeps every other record as one JSON object
 * per line, and `JSON.stringify` quotes correctly for free. The CSV this replaced
 * needed a hand-written field parser and a rule for short legacy rows — 30 lines
 * of machinery to re-implement what one stdlib call already does.
 *
 * Three columns are host-reported (`tokens_*`, `wall_clock_min`, `human_opened`)
 * and two are judgement calls; blank always means "not recorded", never "no".
 * Every value is validated, because a typo that silently lands as "no" understates
 * the one metric §9 actually rests on.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DEFAULT = join(HERE, "RUNLOG.jsonl");
let LOG = LOG_DEFAULT;

/** The row shape, in order. A key outside this list is a bug, not a column, and a
 * missing key is written as "" so the mean stays honest about who did answer. */
const FIELDS = [
  "recorded_at",
  "case_id",
  "repo",
  "provenance", // real | constructed — who chose this bug
  "outcome", // reproduced | does_not_reproduce | error
  "stop_correct", // derived: did the gate refuse what it should refuse?
  "first_falsification_hit", // rank of the confirmed candidate, "" if none
  "survived_verify", // yes | no | not-run (M3)
  "duck_claim_right", // was the root cause actually right? yes|no|none (M8, human-judged)
  "plain_claim_right", // the same judgement of the bare "fix this" run (M9); none = no claim
  "decision_changed", // did the case file change what was done next (M4, the §9 claim)
  "human_opened", // did anyone open it at all (M4n) — attention, not usefulness
  "memory_changed_search", // yes | no | n/a (M5) — needs the paired run, design §8.4
  "pair_case_id", // the blind run this row beat (M5); blank = no pair was run
  "tokens_plain", // host-reported
  "tokens_duck", // host-reported
  "wall_clock_min", // host-reported
  "note",
];

const YES_NO = ["yes", "no"];
const YES_NO_NA = ["yes", "no", "n/a"];
/**
 * §9's headline is a comparison — "fewer confident wrong root-cause claims than the
 * unconstrained agent" — and a ledger that records only cost cannot answer it. Both
 * sides need a verdict. `none` is a first-class answer and not a failure: a run that
 * refuses to name a cause filed no confident wrong claim, which is the behaviour the
 * whole skill exists to produce, so it must count in the denominator and not in the
 * numerator. Blank means nobody judged it, which is a different fact again.
 */
const CLAIM = ["yes", "no", "none"];
const CLAIM_OR_NOT_RUN = [...CLAIM, "not-run"];
const PROVENANCE = ["real", "constructed"];

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

function number(flag, value, { min = 0, integer = true } = {}) {
  if (value === undefined) return "";
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n)))
    return fail(`${flag} wants a number ≥ ${min}${integer ? " (whole)" : ""}, got "${value}"`);
  return n;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report" || a === "--record") opts.mode = a.slice(2);
    // The CSV ledger is gone: answer with guidance and exit 2, not a stack trace.
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
  const provenance = oneOf("--provenance", opts.provenance ?? "constructed", PROVENANCE);
  const opened = oneOf("--opened", opts.opened, YES_NO);
  const changed = oneOf("--changed-decision", opts["changed-decision"], YES_NO);
  const memory = oneOf("--memory-changed", opts["memory-changed"], YES_NO_NA);
  const duckClaim = oneOf("--duck-claim", opts["duck-claim"], CLAIM);
  const plainClaim = oneOf("--plain-claim", opts["plain-claim"], CLAIM_OR_NOT_RUN);
  // Free text is fine here: it names a case in a store and is never used as a path.
  // It is its own column rather than a sentence in --note because M5 without the pair
  // is an anecdote, and a reader must be able to tell those apart without parsing prose.
  const pairCase = (opts["pair-case"] ?? "").trim();
  const wall = number("--wall-clock", opts["wall-clock"], { min: 0, integer: false });
  const tp = number("--tokens-plain", opts["tokens-plain"]);
  const td = number("--tokens-duck", opts["tokens-duck"]);
  if (
    [provenance, opened, changed, memory, duckClaim, plainClaim, wall, tp, td].some(
      (v) => v === null,
    )
  )
    return;

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
    human_opened: opened,
    decision_changed: changed,
    memory_changed_search: memory,
    duck_claim_right: duckClaim,
    plain_claim_right: plainClaim,
    pair_case_id: pairCase,
    tokens_plain: tp,
    tokens_duck: td,
    wall_clock_min: wall,
    note: opts.note ?? "",
  };
  mkdirSync(dirname(LOG), { recursive: true });
  // A re-record replaces the row, so it may only ADD to what the first one knew:
  // re-running --record after --verify without retyping every flag must not erase
  // a judgement that was already made, or file a real bug as a constructed fixture.
  const prior = read().find((r) => r.case_id && r.case_id === row.case_id);
  if (prior) {
    // `provenance` arrives defaulted rather than blank, so it needs naming:
    // inheriting it keeps a real bug real when someone re-logs with no flags.
    if (opts.provenance === undefined) row.provenance = prior.provenance || row.provenance;
    for (const f of FIELDS)
      if (f !== "recorded_at" && f !== "provenance" && (row[f] ?? "") === "" && prior[f] != null)
        row[f] = prior[f];
  }
  const line = JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, row[f] ?? ""]))) + "\n";
  // One row per case id, rewritten in place — the store's own rule, for the same
  // reason: re-logging an investigation after `--verify` ran must refresh it, not
  // count it twice. A line this tool cannot parse is nobody's case id, so it stays.
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
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Metrics per group, so a constructed fixture never shares a denominator with someone else's bug. */
function summarise(g) {
  const answered = (f, ok = (v) => Boolean(v)) => g.filter((r) => ok(r[f]));
  const yes = (f) => answered(f, (v) => v === "yes").length;
  const stops = answered("outcome", (v) => v === "does_not_reproduce" || v === "error");
  const repro = answered("outcome", (v) => v === "reproduced");
  const ranks = repro
    .map((r) => Number(r.first_falsification_hit))
    .filter((n) => Number.isInteger(n) && n > 0);
  const firstHit = ranks.filter((n) => n === 1).length;
  // §9's continue-branch threshold is "first or second candidate", so the rank<=2
  // share is printed next to the rank-1 share: a metric that measures a slightly
  // different sentence than the one the decision cites gets ignored quietly.
  const withinTwo = ranks.filter((n) => n <= 2).length;
  const retested = answered("survived_verify", (v) => v && v !== "not-run");
  const decisions = answered("decision_changed");
  const opened = answered("human_opened");
  const mem = answered("memory_changed_search", (v) => ["yes", "no"].includes(v));
  // A side "ran" when somebody judged its conclusion — including the judgement that it
  // made no claim, which is a win and not a miss. `not-run` (no baseline performed) and
  // blank (nobody judged) sit outside the denominator: scoring a bug you never ran as a
  // bare-agent success is precisely how this comparison would flatter the tool.
  const claimShare = (f) => {
    const judged = g.filter((r) => CLAIM.includes(r[f]));
    return { wrong: judged.filter((r) => r[f] === "no").length, judged: judged.length };
  };
  const duck = claimShare("duck_claim_right");
  const plain = claimShare("plain_claim_right");
  const tp = g.map((r) => r.tokens_plain).filter(Number.isFinite);
  const td = g.map((r) => r.tokens_duck).filter(Number.isFinite);
  const wall = g.map((r) => r.wall_clock_min).filter(Number.isFinite);
  const line = (id, label, value) => `  ${id.padStart(3)}. ${label.padEnd(44)} ${value}`;
  const row = (id, label, num, den) =>
    line(id, label, den ? `${pct(num, den)}  [${num}/${den}]` : "no data");
  return [
    row("M1", "stopped correctly (stale + broken)", yes("stop_correct"), stops.length),
    line(
      "M2",
      "confirmed on the FIRST candidate",
      repro.length
        ? `${pct(firstHit, repro.length)}  [${firstHit}/${repro.length}]  rank≤2: ${withinTwo}`
        : "no data",
    ),
    row("M3", "claim survived --verify", yes("survived_verify"), retested.length),
    row("M4", "case file CHANGED a decision", yes("decision_changed"), decisions.length),
    row("M4n", "case file merely opened (attention)", yes("human_opened"), opened.length),
    row("M5", "memory changed what was tried", yes("memory_changed_search"), mem.length),
    line(
      "M5p",
      "M5 answers naming their blind run",
      `${
        g.filter((r) => ["yes", "no"].includes(r.memory_changed_search) && r.pair_case_id).length
      }/${mem.length || 0} answered`,
    ),
    line(
      "M6",
      'tokens: bare "fix this" vs Ducktective',
      `${tp.length && tp.length === td.length ? `${(mean(tp) / mean(td)).toFixed(2)}\u00d7` : "no data"}  [${Math.min(tp.length, td.length)}/${g.length}]`,
    ),
    line(
      "M7",
      "wall-clock per investigation",
      `${wall.length ? `${mean(wall).toFixed(1)} min mean` : "no data"}  [${wall.length}/${g.length}]`,
    ),
    // Last, because §9 reads them as a pair: two numbers and the count of bugs where
    // both sides actually ran. A comparison over one-sided rows is not a comparison.
    row("M8", "confident-wrong root cause: Ducktective", duck.wrong, duck.judged),
    line(
      "M9",
      'confident-wrong root cause: bare "fix this"',
      `${plain.judged ? `${pct(plain.wrong, plain.judged)}  [${plain.wrong}/${plain.judged}]` : "no data"}  paired: ${g.filter((r) => CLAIM.includes(r.duck_claim_right) && CLAIM.includes(r.plain_claim_right)).length}`,
    ),
  ];
}

function report() {
  const rows = read().filter((r) => !r._corrupt);
  const real = rows.filter((r) => r.provenance === "real");
  const blocks = [["all rows", rows]];
  // The real subset is printed only when it exists AND differs from `all`,
  // otherwise the same seven numbers appear twice and read as two findings.
  if (real.length && real.length !== rows.length) blocks.push(["real rows only", real]);
  console.log(
    `Ducktective run log — ${rows.length} row(s): ${real.length} real, ${rows.length - real.length} constructed\n`,
  );
  for (const [label, g] of blocks) {
    console.log(`  [${label}: ${g.length}]`);
    console.log(summarise(g).join("\n"));
    console.log("");
  }
  console.log(
    "  M4, not M4n, is what design \u00a79 rests on: opening a file is self-gameable.\n" +
      "  M8 vs M9 is the other half of \u00a79, and it is only a comparison across paired\n" +
      "      rows: one-sided numbers tell you about one run, not about the bare agent.",
  );
  if (!real.length)
    console.log(
      "\n  \u26a0 ZERO real rows. Nothing here measures the product; it measures fixtures.\n" +
        "    Design \u00a78.2 is the work: 10\u201315 real bugs, logged the same day, one fixed decision date.",
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
          "    [--provenance real|constructed] [--tokens-plain N --tokens-duck N --wall-clock N] \\\n" +
          "    [--opened yes|no] [--changed-decision yes|no] [--memory-changed yes|no|n/a] \\\n" +
          "    [--duck-claim yes|no|none] [--plain-claim yes|no|none|not-run] \\\n" +
          "    [--pair-case BLIND_RUN_CASE_ID]\n" +
          "  node evals/runlog.mjs [--log PATH] --report",
      );
  }
}
