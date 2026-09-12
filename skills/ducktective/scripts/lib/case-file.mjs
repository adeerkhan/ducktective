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

  // Rule 4+6: a verdict is a check that ran, printed, and was recorded. A
  // `pending` candidate is an unexamined lead, so it owes nothing yet — that is
  // what makes persisting an `open` case mid-investigation legal.
  for (const cand of c.candidates ?? []) {
    if (cand.verdict !== "pending" && !text(cand.hypothesis)) {
      bad.push(`candidate "${cand.location}": verdict "${cand.verdict}" with no hypothesis stated`);
    }
    if (cand.verdict === "confirmed" || cand.verdict === "falsified") {
      if (!text(cand.check))
        bad.push(`candidate "${cand.location}": verdict "${cand.verdict}" with no check to run`);
      if (!text(cand.evidence))
        bad.push(
          `candidate "${cand.location}": verdict "${cand.verdict}" with no captured output (rule 6)`,
        );
      // A verdict is an executed oracle, not an opinion: `run_check.mjs` records
      // what it predicted and what the process actually returned, so a verdict
      // typed by hand has nowhere to hide.
      if (cand.predicted !== "pass" && cand.predicted !== "fail") {
        bad.push(
          `candidate "${cand.location}": verdict "${cand.verdict}" has no "predicted" oracle — record it with run_check.mjs (rule 6)`,
        );
      } else if (typeof cand.check_exit_code !== "number") {
        bad.push(
          `candidate "${cand.location}": verdict "${cand.verdict}" but the check has no recorded exit code`,
        );
      } else {
        const passed = cand.check_exit_code === 0;
        const held = cand.predicted === "pass" ? passed : !passed;
        const wanted = held ? "confirmed" : "falsified";
        if (cand.verdict !== wanted) {
          bad.push(
            `candidate "${cand.location}": verdict "${cand.verdict}" contradicts its own check (predicted ${cand.predicted}, exit ${cand.check_exit_code} ⇒ ${wanted})`,
          );
        }
      }
      // Metric #2 enforcement: --verify exists so a claim can be re-tested.
      // Recording the second run and then filing the original verdict anyway is
      // the confident wrong answer this skill exists to catch.
      if (cand.verified_verdict != null && cand.verified_verdict !== cand.verdict) {
        bad.push(
          `candidate "${cand.location}": the second run said "${cand.verified_verdict}" — a claim that did not survive re-execution cannot be filed as "${cand.verdict}"`,
        );
      }
      // Rule 5: an oracle that fails on a known-good path discriminates nothing.
      if (
        cand.verdict === "confirmed" &&
        typeof cand.control_exit_code === "number" &&
        cand.control_exit_code !== 0
      ) {
        bad.push(
          `candidate "${cand.location}": the control command also failed (exit ${cand.control_exit_code}) — bad oracle, it distinguishes nothing (rule 5)`,
        );
      }
    }
  }

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
  const lines = [
    `# ${c.id} — ${c.symptom.split("\n")[0].slice(0, 80) || "untitled symptom"}`,
    "",
    `**Status:** \`${c.status}\` · **Confidence:** ${c.confidence} · **Opened:** ${c.opened_at}`,
    `**Reproduction:** \`${r.command}\` → \`${r.outcome}\` in ${Math.round(r.duration_ms ?? 0)} ms (exit ${r.exit_code ?? "?"})`,
    "",
    "## Symptom",
    "",
    c.symptom || "_none recorded_",
    "",
    "## Reproduction evidence",
    "",
  ];
  if ((r.stack ?? []).length) lines.push("```", ...r.stack, "```", "");
  if (r.stderr?.trim()) lines.push("```", clip(r.stderr, 1200), "```", "");
  if ((r.covered ?? []).length) {
    lines.push(
      `Covered by the failing run only: ${r.covered.map((s) => `${s.file}:${s.line}`).join(", ")}`,
      "",
    );
  }
  lines.push("## Candidates", "");
  if (!(c.candidates ?? []).length) {
    lines.push("_None. The gate stopped the investigation before localization._", "");
  }
  for (const cand of c.candidates ?? []) {
    const block = [
      `### ${cand.rank ?? "–"}. \`${cand.location}\` — ${cand.verdict}`,
      "",
      cand.why ? `*Why:* ${cand.why}` : null,
      `*Hypothesis:* ${cand.hypothesis || "not stated"}`,
    ];
    if (cand.check) block.push("", "```", cand.check, "```");
    if (cand.evidence) block.push("", "*Evidence:*", "", "```", clip(cand.evidence, 900), "```");
    lines.push(...block, "");
  }
  lines.push("## Finding", "");
  if (c.confirmed_cause) lines.push(`**Confirmed cause:** ${c.confirmed_cause}`, "");
  if (c.leading_hypothesis)
    lines.push(`**Leading hypothesis (unverified):** ${c.leading_hypothesis}`, "");
  if (c.status === "does_not_reproduce")
    lines.push(
      "**Did not reproduce.** The ticket may be stale; no code was changed or proposed.",
      "",
    );
  if (c.suggested_patch)
    lines.push(
      "## Suggested patch (secondary)",
      "",
      "```diff",
      clip(c.suggested_patch, 2000),
      "```",
      "",
    );
  if (c.notes) lines.push("## Notes", "", c.notes, "");
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

/**
 * Append (or update in place, when the same id is re-submitted) one case file.
 *
 * The JSONL is the machine-readable record other skills may read one day; the
 * Markdown is what a human actually opens tomorrow morning. Both are written
 * here so they can never disagree.
 */
export function writeCase(c, repoDir) {
  // Callers that skip validation (my own tests, any host editing by hand) still
  // cannot aim a write outside the store.
  if (!CASE_ID.test(c?.id ?? ""))
    throw new Error(`refusing to store a case with an unsafe id: ${JSON.stringify(c?.id)}`);
  const dir = join(repoDir, STORE_DIR);
  mkdirSync(join(dir, "cases"), { recursive: true });
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
