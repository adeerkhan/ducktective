/**
 * The case file: schema validation, the refusal rules, and the store writer.
 *
 * Why this exists as code and not just prose in SKILL.md: a host agent under
 * pressure to answer will read "never confirm a cause in prose" as a
 * suggestion. `write_case.mjs` treats it as a type error — a speculative case
 * file cannot be written, so the discipline survives the model that runs it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateViolations,
  caseReportability,
  causeIdentity,
  whyViolations,
} from "./verdict-policy.mjs";

/** The schema is the single source of shape; SKILL.md names these fields too. */
export const SCHEMA = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../case-file.schema.json", import.meta.url)), "utf8"),
);

/** Where a repo's case files live. Design doc: files, greppable, no database. */
export const STORE_DIR = ".ducktective";
export const JSONL = "cases.jsonl";

/**
 * Case ids are used to build filenames, and the draft they come from is
 * model-authored, so this is a containment guard, not cosmetics: no `/`, no
 * `\`, no `.`, which is exactly what `^DT-` failed to forbid. `DT-../../x`
 * passed the prefix pattern and wrote outside `.ducktective/cases/`.
 */
export const CASE_ID = /^DT-[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

/** `DT-260912-3f9a2c` — sortable by day, and a collision can't eat a real case. */
export function newCaseId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${p(now.getFullYear() % 100)}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `DT-${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * Validate against the subset of JSON Schema this repo uses: type (single or
 * union), enum, required, properties, items, pattern, maxItems,
 * additionalProperties:false. Hand-rolled instead of `ajv` so the skill stays a
 * copy-one-folder install with zero dependencies.
 */
export function validateSchema(value, schema = SCHEMA, at = "") {
  const bad = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!types.includes(actual)) {
      bad.push(`${at || "case"}: expected ${types.join("|")}, got ${actual}`);
      return bad;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    bad.push(`${at || "case"}: "${String(value)}" is not one of ${schema.enum.join(", ")}`);
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    bad.push(`${at}: "${value}" does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      bad.push(`${at}: ${value.length} items exceeds the cap of ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) => bad.push(...validateSchema(item, schema.items, `${at}[${i}]`)));
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) bad.push(`${at || "case"}: missing required "${key}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined)
        bad.push(...validateSchema(value[key], sub, at ? `${at}.${key}` : key));
    }
    // A misspelled field otherwise validates and later reads as `undefined`,
    // which is how a case file quietly loses its confidence or its candidates.
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {})))
          bad.push(`${at || "case"}: unknown property "${key}"`);
      }
    }
  }
  return bad;
}

const text = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * Policy violations — the hard rules from SKILL.md that the schema cannot say.
 * Returns human-readable reasons; any non-empty result means refuse to write.
 */
export function policyViolations(c) {
  const bad = [];
  const outcome = c.reproduction?.outcome;
  const confirmed = (c.candidates ?? []).filter((x) => x.verdict === "confirmed");

  // Rule 1+2: nothing is allowed to reason about a bug that never failed.
  if (!text(c.symptom)) bad.push("symptom is empty — record what was reported, verbatim");
  if (outcome !== "reproduced") {
    if ((c.candidates ?? []).length > 0) {
      bad.push(
        `reproduction outcome is "${outcome}" — a non-reproducing case must stop with zero candidates (SKILL.md rule 2)`,
      );
    }
    if (c.status === "confirmed") bad.push(`status "confirmed" requires outcome "reproduced"`);
  }

  // Rule 4+6 and the receipt arithmetic live in verdict-policy.mjs, shared with
  // run_check.mjs classify(), so the tool cannot compute a verdict the store
  // refuses (or the reverse). A `pending` candidate is an unexamined lead, so it
  // owes nothing yet — that is what makes persisting an `open` case legal.
  for (const cand of c.candidates ?? []) bad.push(...candidateViolations(cand));

  // A cause, or strong confidence, is a claim: it only travels with a verdict
  // that ran. High confidence on an `open` case is the exact artifact this skill
  // exists to prevent — same document, more authoritative-looking.
  if (text(c.confirmed_cause) && c.status !== "confirmed") {
    bad.push(`confirmed_cause requires status "confirmed" — otherwise it is leading_hypothesis`);
  }
  if (["high", "medium"].includes(c.confidence) && c.status !== "confirmed") {
    bad.push(
      `confidence "${c.confidence}" requires status "confirmed"; an unconfirmed case is low or none`,
    );
  }

  if (c.status === "confirmed") {
    if (confirmed.length === 0)
      bad.push(`status "confirmed" but no candidate has verdict "confirmed"`);
    if (!text(c.confirmed_cause)) bad.push(`status "confirmed" needs confirmed_cause`);
    if (c.confidence === "none") bad.push(`status "confirmed" cannot have confidence "none"`);
  }
  // Rule 8 + §5: unverified work is labelled, never presented as a cause.
  if (c.status === "unverified" || c.status === "exhausted") {
    if (!text(c.leading_hypothesis))
      bad.push(`status "${c.status}" needs leading_hypothesis (label it, don't hide it)`);
    if (confirmed.length > 0) bad.push(`status "${c.status}" contradicts a confirmed candidate`);
  }
  // Rule 7: a patch follows a confirmed cause.
  if (text(c.suggested_patch) && c.status !== "confirmed") {
    bad.push(
      `suggested_patch requires status "confirmed" (rule 7) — record it in notes as secondary instead`,
    );
  }
  return bad;
}

/**
 * Trim evidence to something a human reads in 30 seconds, keeping BOTH ends:
 * the failure summary of pytest and the exception of a traceback sit at the
 * tail, so head-only truncation throws away the only line that matters.
 */
export function clip(s, n = 800) {
  const t = (s ?? "").trim();
  if (t.length <= n) return t;
  const half = Math.floor(n / 2);
  return `${t.slice(0, half)}\n… ${t.length - n} chars elided …\n${t.slice(-half)}`;
}

/**
 * The Markdown mirror: same facts as the JSON, in reading order.
 *
 * `null` means "omit this line"; `""` means "blank line", and both must survive
 * the join or the document arrives as one unbroken wall of text.
 */
export function renderMarkdown(c) {
  const r = c.reproduction ?? {};
  const report = caseReportability(c);
  const stamp =
    {
      confirmed: "CONFIRMED",
      does_not_reproduce: "DOES NOT REPRODUCE",
      exhausted: "EXHAUSTED",
      unverified: "UNVERIFIED",
      open: "OPEN",
    }[c.status] ?? String(c.status ?? "").toUpperCase();
  const lines = [
    `# ${c.id} — ${c.symptom.split("\n")[0].slice(0, 80) || "untitled symptom"}`,
    "",
    `**${stamp}** · Confidence: ${c.confidence} · Cause confidence: ${report.confidence}${
      report.reportable ? "" : ` _(not reportable: ${report.reason})_`
    }`,
    `**Reproduction:** \`${r.command}\` → \`${r.outcome}\` in ${Math.round(r.duration_ms ?? 0)} ms (exit ${r.exit_code ?? "?"})`,
    c.cause_hash ? `**Cause:** \`${c.cause_hash}\` (seen ${c.count ?? 1}×)` : null,
    "",
    "## Symptom",
    "",
    c.symptom || "_none recorded_",
    "",
    "## Finding",
    "",
  ];
  if (c.confirmed_cause) lines.push(`**Confirmed cause:** ${c.confirmed_cause}`, "");
  else if (c.leading_hypothesis)
    lines.push(`**Leading hypothesis (unverified):** ${c.leading_hypothesis}`, "");
  else if (c.status === "does_not_reproduce")
    lines.push(
      "**Did not reproduce.** The ticket may be stale; no code was changed or proposed.",
      "",
    );
  else lines.push("_No cause was confirmed._", "");

  lines.push("## Candidates", "");
  if (!(c.candidates ?? []).length)
    lines.push("_None — the gate stopped the investigation before localization._", "");
  for (const cand of c.candidates ?? []) {
    lines.push(
      `${cand.rank ?? "–"}. \`${cand.location}\` — **${cand.verdict}**`,
      `   - hypothesis: ${cand.hypothesis || "not stated"}`,
      cand.check ? `   - check: \`${String(cand.check).split("\n")[0].slice(0, 120)}\`` : null,
      (cand.probe_flipped ?? "not-run") !== "not-run" ? `   - probe: ${cand.probe_flipped}` : null,
      `   - evidence: ${clip((cand.evidence ?? "").replace(/\s+/g, " ").trim(), 300) || "none recorded"}`,
      "",
    );
  }
  if ((c.why_violations ?? []).length)
    lines.push(`_Consistency (E5): ${c.why_violations.join("; ")}_`, "");

  if ((r.stack ?? []).length)
    lines.push(
      "<details><summary>stack</summary>",
      "",
      "```",
      ...r.stack.slice(0, 8),
      "```",
      "",
      "</details>",
      "",
    );
  if (r.stderr?.trim())
    lines.push(
      "<details><summary>stderr</summary>",
      "",
      "```",
      clip(r.stderr, 800),
      "```",
      "",
      "</details>",
      "",
    );
  if (c.suggested_patch)
    lines.push(
      "## Suggested patch (secondary)",
      "",
      "```diff",
      clip(c.suggested_patch, 1500),
      "```",
      "",
    );
  if (c.notes) lines.push("## Notes", "", c.notes, "");
  lines.push("_No patch was applied; this file is the finding._", "");
  return (
    lines
      .filter((l) => l !== null)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n") + "\n"
  );
}

/**
 * The store, read as raw lines.
 *
 * `rows` and `raw` are index-aligned and may disagree in length only when a
 * line is unparseable — and then the raw line is kept, because a rewrite that
 * rebuilds the file from parsed rows alone deletes whatever the parse skipped.
 */
export function readStore(repoDir) {
  const path = join(repoDir, STORE_DIR, JSONL);
  const raw = existsSync(path)
    ? readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim())
    : [];
  const rows = [];
  const corrupt = [];
  raw.forEach((line, i) => {
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push(null);
      corrupt.push({ line: i + 1, raw: line });
    }
  });
  return { path, raw, rows, corrupt };
}

/** Every stored case, newest last. Unparseable lines read as absent. */
export function readCases(repoDir) {
  return readStore(repoDir).rows.filter(Boolean);
}

/** Write via temp + rename: a crash can't leave a half-written store. */
export function writeAtomic(path, body) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

/** The cause index: one line per distinct root cause, upserted by hash. */
export const CAUSE_INDEX = "causes.jsonl";

/** The cause index, read as raw lines. Corrupt lines are preserved on rewrite. */
export function readCauseIndex(repoDir) {
  const path = join(repoDir, STORE_DIR, CAUSE_INDEX);
  const raw = existsSync(path)
    ? readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim())
    : [];
  const rows = [];
  raw.forEach((line) => {
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push(null);
    }
  });
  return { path, raw, rows };
}

/** Every distinct cause in a repo, most recurrent first — the preventative read. */
export function listCauses(repoDir) {
  return readCauseIndex(repoDir)
    .rows.filter(Boolean)
    .map((r) => ({
      cause_hash: r.cause_hash,
      cause_key: r.cause_key ?? [],
      count: r.count ?? (r.case_ids ?? []).length,
      case_ids: r.case_ids ?? [],
      last_seen: r.last_seen ?? "",
    }))
    .sort((a, b) => b.count - a.count || String(a.cause_hash).localeCompare(String(b.cause_hash)));
}

/**
 * Append (or update in place, when the same id is re-submitted) one case file,
 * and upsert its cause in the recurrence index.
 *
 * The JSONL is the machine-readable record other skills may read one day; the
 * Markdown is what a human actually opens tomorrow morning. Both are written
 * here so they can never disagree. `cause_hash`/`cause_key`/`count` are derived
 * here, not typed by a model, so a repeated root cause becomes a recurrence
 * count instead of a near-duplicate row.
 */
export function writeCase(c, repoDir) {
  // Callers that skip validation (my own tests, any host editing by hand) still
  // cannot aim a write outside the store.
  if (!CASE_ID.test(c?.id ?? ""))
    throw new Error(`refusing to store a case with an unsafe id: ${JSON.stringify(c?.id)}`);

  const dir = join(repoDir, STORE_DIR);
  mkdirSync(join(dir, "cases"), { recursive: true });

  // E5: record (do not refuse) a why/hypothesis that cites a location nowhere in
  // this case's own evidence. The rate is metric C9; a gate waits on the data.
  const why = whyViolations(c);
  if (why.length) c.why_violations = why;

  const { hash, key } = causeIdentity(c);
  const index = readCauseIndex(repoDir);
  const rec = index.rows.find((r) => r?.cause_hash === hash);
  const caseIds = new Set(rec?.case_ids ?? []);
  caseIds.add(c.id);
  const entry = {
    cause_hash: hash,
    cause_key: key,
    case_ids: [...caseIds],
    count: caseIds.size,
    last_seen: new Date().toISOString().slice(0, 10),
  };
  const prev = index.raw.findIndex((l) => {
    try {
      return JSON.parse(l).cause_hash === hash;
    } catch {
      return false;
    }
  });
  if (prev >= 0) index.raw[prev] = JSON.stringify(entry);
  else index.raw.push(JSON.stringify(entry));
  writeAtomic(index.path, index.raw.join("\n") + "\n");

  c.cause_hash = hash;
  c.cause_key = key;
  c.count = entry.count;
  const report = caseReportability(c);
  c.cause_confidence = report.confidence;
  c.not_reportable = report.reason || null;

  const { path, raw, rows, corrupt } = readStore(repoDir);
  const line = JSON.stringify(c);
  const idx = rows.findIndex((r) => r?.id === c.id);
  if (idx >= 0) {
    raw[idx] = line;
  } else {
    raw.push(line);
  }
  writeAtomic(path, raw.join("\n") + "\n");
  const md = join(dir, "cases", `${c.id}.md`);
  writeAtomic(md, renderMarkdown(c));
  return {
    jsonl: path,
    markdown: md,
    replaced: idx >= 0,
    preservedCorruptLines: corrupt.length,
    cause_hash: hash,
    cause_count: entry.count,
  };
}

/**
 * Repo the store belongs to: nearest ancestor with `.git`.
 *
 * Falls back to `start`, not the filesystem root — a tarball or CI checkout with
 * no `.git` must not create `.ducktective/` next to `C:\Users` or `/`.
 */
export function repoRoot(start = process.cwd()) {
  const origin = resolve(start);
  let dir = origin;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return origin;
    dir = up;
  }
}
