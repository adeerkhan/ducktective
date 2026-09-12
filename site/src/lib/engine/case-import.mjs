/**
 * Read a real case file.
 *
 * The skill writes snake_case JSON — `skills/ducktective/case-file.schema.json`
 * is the contract — and the workbench demo renders a camelCase view model. This
 * is the only place allowed to know both shapes, so the demo cannot quietly
 * invent fields the product does not have.
 *
 * Plain `.mjs` with JSDoc types on purpose: `npm test` at the repo root runs
 * this file directly, so the mapping is actually verified instead of assumed.
 *
 * @typedef {import("./types.ts").CaseFile} CaseFile
 * @typedef {import("./types.ts").Candidate} Candidate
 */

/**
 * Same rule as skills/ducktective/scripts/lib/case-file.mjs, deliberately
 * duplicated rather than imported: the site must not depend on the skill's
 * scripts. Those files name `.ducktective/cases/<id>.md` and, in run_check's
 * case, write AND execute `ducktective-check-<id>-<rank>.<ext>` — so a loose
 * prefix pattern let `DT-../../pwned` climb out of the directory. Keep in step.
 */
const CASE_ID = /^DT-[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

/** Fields the skill may leave null; the view model wants `undefined` instead. */
const opt = (/** @type {string | null | undefined} */ v) =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** @param {unknown} status @returns {status is CaseFile["status"]} */
const STATUS = new Set(["open", "confirmed", "does_not_reproduce", "exhausted", "unverified"]);

/**
 * One canonical case → the demo's shape.
 *
 * @param {any} raw a parsed line from `.ducktective/cases.jsonl`
 * @param {string} [source] label for the sheet's repo slot
 * @returns {{ case?: CaseFile, error?: string }}
 */
export function fromCaseFile(raw, source = "cases.jsonl") {
  if (!raw || typeof raw !== "object") return { error: "line is not an object" };
  if (typeof raw.id !== "string" || !CASE_ID.test(raw.id))
    return {
      error: `${raw?.id ?? "?"}: id is not a safe filename (DT- then letters, digits or hyphens)`,
    };
  if (!STATUS.has(raw.status))
    return { error: `${raw.id}: status "${raw.status}" is not one the sheet can stamp` };
  const r = raw.reproduction ?? {};
  const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  /** @type {Candidate[]} */
  const cands = candidates.map((/** @type {any} */ c, /** @type {number} */ i) => ({
    id: `${raw.id}-${c.rank ?? i + 1}`,
    rank: typeof c.rank === "number" ? c.rank : i + 1,
    location: String(c.location ?? "unknown"),
    why: String(c.why ?? ""),
    hypothesis: String(c.hypothesis ?? ""),
    // The skill records the command that ran, then the script it came from.
    checkName:
      String(c.check ?? "")
        .split("\n")[0]
        .slice(0, 80) || `check ${i + 1}`,
    checkSource: String(c.check ?? ""),
    verdict: ["pending", "falsified", "confirmed", "inconclusive"].includes(c.verdict)
      ? c.verdict
      : "pending",
    evidence: String(c.evidence ?? ""),
    // Provenance the sheet must show, or a verdict is unverifiable on a page.
    predicted: c.predicted === "pass" || c.predicted === "fail" ? c.predicted : undefined,
    checkExitCode: typeof c.check_exit_code === "number" ? c.check_exit_code : null,
    control: opt(c.control),
    controlExitCode: typeof c.control_exit_code === "number" ? c.control_exit_code : null,
    verifiedVerdict: ["confirmed", "falsified", "inconclusive"].includes(c.verified_verdict)
      ? c.verified_verdict
      : undefined,
    verifyExitCode: typeof c.verified_exit_code === "number" ? c.verified_exit_code : null,
  }));

  /** @type {CaseFile} */
  const out = {
    id: raw.id,
    fixtureId: "imported",
    title:
      String(raw.symptom ?? "")
        .split("\n")[0]
        .slice(0, 90) || "imported case",
    repo: source,
    openedAt: String(raw.opened_at ?? ""),
    symptom: String(raw.symptom ?? ""),
    reproduction: {
      command: String(r.command ?? "not recorded"),
      outcome: ["reproduced", "does_not_reproduce", "error"].includes(r.outcome)
        ? r.outcome
        : "error",
      durationMs: Number.isFinite(r.duration_ms) ? r.duration_ms : 0,
      exitCode: Number.isFinite(r.exit_code) ? r.exit_code : null,
      runner: ["pytest", "unittest", "node-test", "unknown"].includes(r.runner)
        ? r.runner
        : undefined,
      stdout: String(r.stdout ?? ""),
      stderr: String(r.stderr ?? ""),
      stack: Array.isArray(r.stack) ? r.stack.map(String) : [],
      covered: (Array.isArray(r.covered) ? r.covered : []).map((/** @type {any} */ s) => ({
        id: `${s.file}:${s.line}`,
        file: String(s.file),
        label: `${s.file}:${s.line}`,
        failHits: 1,
        passHits: 0,
      })),
    },
    candidates: cands,
    confirmedCause: opt(raw.confirmed_cause),
    leadingHypothesis: opt(raw.leading_hypothesis),
    confidence: ["high", "medium", "low", "none"].includes(raw.confidence)
      ? raw.confidence
      : "none",
    suggestedPatch: opt(raw.suggested_patch),
    status: raw.status,
    notes: String(raw.notes ?? ""),
  };
  return { case: out };
}

/**
 * Parse a whole `cases.jsonl` body.
 *
 * @param {string} text
 * @param {string} [source]
 * @returns {{ cases: CaseFile[], errors: string[] }}
 */
export function parseCasesJsonl(text, source) {
  /** @type {CaseFile[]} */
  const cases = [];
  /** @type {string[]} */
  const errors = [];
  text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .forEach((line, i) => {
      /** @type {any} */
      let raw = null;
      try {
        raw = JSON.parse(line);
      } catch {
        errors.push(`line ${i + 1}: not JSON`);
        return;
      }
      const { case: mapped, error } = fromCaseFile(raw, source);
      if (error) errors.push(`line ${i + 1}: ${error}`);
      else if (mapped) cases.push(mapped);
    });
  // Newest first: the sheet reads like a stack of open cases, not an archive.
  cases.sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
  return { cases, errors };
}
