#!/usr/bin/env node
/**
 * query_memory — the rap sheet. Two or three past cases, before the work starts.
 *
 *   node skills/ducktective/scripts/query_memory.mjs --symptom "totals drop the last row"
 *   node skills/ducktective/scripts/query_memory.mjs --symptom "…" --locations app.py:7 --json
 *
 * Keyword overlap, not embeddings: the store is a JSONL a human can read, the
 * matching has to run with zero dependencies and zero network, and on a corpus
 * of tens of cases per repo a Jaccard-ish overlap finds the obvious repeats.
 *
 * The scoring is the same formula as the site's demo rap sheet
 * (`site/src/lib/engine/memory.ts`), so the browser and the CLI rank identically.
 * If you change one, change both.
 */
import { numFlag } from "./lib/args.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCases, repoRoot, STORE_DIR, JSONL } from "./lib/case-file.mjs";

const USAGE = `usage: query_memory.mjs --symptom TEXT [options]
  --locations LIST     comma-separated file:line leads to match on as well
  --file DRAFT.json    exclude a case from its own results (uses its id)
  --repo DIR           repo whose store to read (default: nearest ancestor with .git)
  --top N              how many cases to surface (default: 3)
  --min SCORE          drop matches below this 0-1 overlap (default: 0.05)
  --json               machine output instead of a paste-ready notes block`;

function parseArgs(argv) {
  const opts = { top: 3, min: 0.05 };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return null;
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`expected a --flag, got "${flag}"\n\n${USAGE}`);
    if (flag === "--json") {
      opts.json = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value\n\n${USAGE}`);
    switch (flag) {
      case "--symptom":
        opts.symptom = value;
        break;
      case "--locations":
        opts.locations = value;
        break;
      case "--file":
        opts.file = value;
        break;
      case "--repo":
        opts.repo = resolve(value);
        break;
      case "--top":
        opts.top = numFlag("--top", value);
        break;
      case "--min":
        opts.min = numFlag("--min", value, { min: 0, max: 1, integer: false });
        break;
      default:
        throw new Error(`unrecognised flag: ${flag}\n\n${USAGE}`);
    }
  }
  if (!opts.symptom && !opts.locations)
    throw new Error(`give me something to match on: --symptom and/or --locations\n\n${USAGE}`);
  return opts;
}

/** Same tokens as the site's rap sheet: lowercase, alphanumerics, longer than two. */
export function tokenize(text) {
  return new Set(
    (text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_$]+/g)
      .filter((t) => t.length > 2),
  );
}

/** Overlap normalized by both sizes, so a one-line symptom isn't a match by volume. */
export function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n / Math.sqrt(a.size * b.size);
}

const blob = (c) =>
  [
    c.symptom,
    ...((c.candidates ?? []).map((x) => x.location) ?? []),
    c.confirmed_cause ?? "",
    c.leading_hypothesis ?? "",
  ].join(" ");

/** Rank the store against a query, newest-first on ties. Accepts text or tokens. */
export function rank(query, cases, { excludeId, top, min }) {
  const q = query instanceof Set ? query : tokenize(query);
  return cases
    .filter((c) => c.id !== excludeId)
    .map((c) => ({ case: c, score: overlap(q, tokenize(blob(c))) }))
    .filter((r) => r.score >= min)
    .sort((a, b) => b.score - a.score || (a.case.opened_at < b.case.opened_at ? 1 : -1))
    .slice(0, top);
}

function summary(c) {
  const cause = c.confirmed_cause ?? c.leading_hypothesis ?? `no verdict (${c.status})`;
  return `${c.id} · ${c.status} · ${String(c.opened_at ?? "?").slice(0, 10)}\n    symptom: ${String(c.symptom).split("\n")[0]}\n    finding: ${cause}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;
  const repo = opts.repo ?? repoRoot();
  const store = join(repo, STORE_DIR, JSONL);
  const query = [opts.symptom ?? "", opts.locations ?? ""].join(" ");
  const excludeId =
    opts.file && existsSync(resolve(opts.file))
      ? JSON.parse(readFileSync(resolve(opts.file), "utf8")).id
      : null;

  const cases = readCases(repo);
  const hits = rank(query, cases, { excludeId, top: opts.top, min: opts.min });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          store,
          cases: cases.length,
          hits: hits.map((h) => ({ score: Number(h.score.toFixed(3)), ...h.case })),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!cases.length) {
    console.log(
      `No prior cases in ${store} — nothing to reuse. This repo's first case file starts here.`,
    );
    return;
  }
  if (!hits.length) {
    console.log(
      `No case among ${cases.length} in ${store} overlaps this symptom. Treat it as new.`,
    );
    return;
  }
  console.log(`Rap sheet — ${hits.length} of ${cases.length} cases in ${store} overlap:\n`);
  for (const h of hits)
    console.log(
      `  ${(h.score * 100).toFixed(0)}%  ${summary(h.case).split("\n").join("\n        ")}\n`,
    );
  console.log('Paste the relevant lines into the case file\'s `notes` as "rap sheet".');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (err) {
    console.error(`[ducktective] query_memory failed: ${err.message}`);
    process.exitCode = 2;
  }
}
