/**
 * The verdict policy, in one place.
 *
 * Before this module the rule lived twice: `classify()` in `run_check.mjs`
 * decided a verdict from an executed check, and `policyViolations()` in
 * `case-file.mjs` re-derived the same arithmetic when deciding whether the
 * verdict could be stored. Two copies of one rule is one copy too many — edit
 * one and the tool computes a verdict the store refuses, or accepts a verdict
 * the arithmetic never produced. Both now call the predicates here, and
 * `verdict-policy.test.mjs` asserts the schema's verdict enum and this module
 * agree (the parity idea borrowed from BugTraceAI-CLI's `finding_policy.py`).
 *
 * This file is pure: no filesystem, no process, no model. It imports only the
 * runnability test, because "the command could not be started at all" is a
 * property of a run result, not of a file.
 *
 * Vocabulary
 * ----------
 * `held` means the prediction matched the observed outcome. A held prediction
 * is necessary for `confirmed` and not sufficient: the check must also carry a
 * discrimination receipt — a passing control (not always-fail) or a flipped
 * probe (its outcome depends on the accused line). A pass prediction can only
 * be confirmed by a flipped probe; a passed control cannot rule out an
 * always-pass oracle.
 *
 * `cause_confidence` is a derived 0..1 rating of how much the recorded receipts
 * support the accused cause. It is arithmetic over the record, never a number a
 * model types. The reportable floor is deliberately the weakest receipt that
 * exists today (control-only = 0.5); it rises when independent replication and
 * the causal-closure probe land, because a floor above today's minimum would
 * refuse cases the current contract accepts.
 */
import { createHash } from "node:crypto";
import { wasNotRunnable } from "./exec.mjs";

/** Candidate verdicts. The schema enum must equal this set (parity test). */
export const VERDICT = Object.freeze({
  PENDING: "pending",
  FALSIFIED: "falsified",
  CONFIRMED: "confirmed",
  INCONCLUSIVE: "inconclusive",
  VACUOUS: "inconclusive_vacuous",
});

export const VERDICTS = Object.freeze(Object.values(VERDICT));

/** Case-level statuses. The schema enum must equal this set (parity test). */
export const CASE_STATUS = Object.freeze({
  OPEN: "open",
  CONFIRMED: "confirmed",
  DOES_NOT_REPRODUCE: "does_not_reproduce",
  EXHAUSTED: "exhausted",
  UNVERIFIED: "unverified",
});

export const CASE_STATUSES = Object.freeze(Object.values(CASE_STATUS));

/** Statuses whose cause may be surfaced to a human as a finding. */
export const REPORTABLE_STATUSES = Object.freeze(new Set([CASE_STATUS.CONFIRMED]));

/**
 * Minimum derived cause-confidence a case must reach to be reportable and to
 * carry `confirmed_cause`, a patch, or `high`/`medium` confidence.
 *
 * 0.5 is today's floor because a passed control alone is a receipt the current
 * contract accepts (base 0.3 + control 0.2). It is raised — not lowered — when
 * replication (L3) and causal closure (L4) become required rungs.
 */
export const CAUSE_CONFIDENCE_FLOOR = Object.freeze({ [CASE_STATUS.CONFIRMED]: 0.5 });

const text = (v) => typeof v === "string" && v.trim().length > 0;

/** A prediction holds when the check did what the hypothesis said it would. */
export function predictionHeld(predicted, exitCode) {
  return (predicted === "pass") === (exitCode === 0);
}

/** The verdict the arithmetic alone produces, before receipts. */
export function expectedVerdict(predicted, exitCode) {
  return predictionHeld(predicted, exitCode) ? VERDICT.CONFIRMED : VERDICT.FALSIFIED;
}

/**
 * Decision arithmetic over executed results. Same parameter order as the old
 * `run_check.mjs classify()`, so a caller that imported it keeps working.
 */
export function classifyVerdict(predicted, checkResult, controlResult, timeout = 0, disc = {}) {
  const { controlPassed = false, probeFlipped = null } = disc;
  const notes = [];
  const inconclusive = (why) => {
    notes.push(why);
    return { verdict: VERDICT.INCONCLUSIVE, notes };
  };
  if (checkResult.timedOut)
    return inconclusive(`the check hung and its process tree was killed after ${timeout} ms`);
  if (wasNotRunnable(checkResult) || !Number.isInteger(checkResult.code))
    return inconclusive(
      "the check command could not be run at all — that is not evidence about the hypothesis",
    );
  if (
    controlResult &&
    (controlResult.code !== 0 || controlResult.timedOut || wasNotRunnable(controlResult))
  )
    return inconclusive(
      "the control also failed, so this check does not distinguish the broken path from a known-good one (rule 5)",
    );
  if (!predictionHeld(predicted, checkResult.code)) return { verdict: VERDICT.FALSIFIED, notes };
  if (probeFlipped === false)
    return {
      verdict: VERDICT.VACUOUS,
      notes: [
        ...notes,
        "the check's outcome did not change when the accused line was neutered — no sensitivity detected under this mutation; this is not proof the check never touched the line",
      ],
    };
  if (predicted === "pass" && probeFlipped !== true)
    return inconclusive(
      "a pass prediction requires a flipped probe — re-run with --probe; a passed control alone cannot rule out an always-pass check",
    );
  if (!controlPassed && probeFlipped !== true)
    return inconclusive(
      "the check agreed with the prediction but has no discrimination receipt — re-run with --control or --probe (rule 5)",
    );
  if (probeFlipped === true)
    notes.push(
      "the flip detects sensitivity under this mutation, not proof the accused line is faulty",
    );
  return { verdict: VERDICT.CONFIRMED, notes };
}

/**
 * The candidate-level refusal rules, in one place. Returns human-readable
 * reasons; any non-empty result refuses the write.
 *
 * These are the SKILL.md hard rules as code, not authenticated execution
 * attestations: fabricated evidence can still satisfy the arithmetic.
 */
export function candidateViolations(cand) {
  const bad = [];
  const loc = cand?.location ?? "?";
  const verdict = cand?.verdict;

  if (verdict !== VERDICT.PENDING && !text(cand.hypothesis))
    bad.push(`candidate "${loc}": verdict "${verdict}" with no hypothesis stated`);

  if (
    verdict === VERDICT.CONFIRMED ||
    verdict === VERDICT.FALSIFIED ||
    verdict === VERDICT.VACUOUS
  ) {
    if (!text(cand.check))
      bad.push(`candidate "${loc}": verdict "${verdict}" with no check to run`);
    if (!text(cand.evidence))
      bad.push(`candidate "${loc}": verdict "${verdict}" with no captured output (rule 6)`);
    if (cand.predicted !== "pass" && cand.predicted !== "fail") {
      bad.push(
        `candidate "${loc}": verdict "${verdict}" has no "predicted" oracle — record it with run_check.mjs (rule 6)`,
      );
    } else if (typeof cand.check_exit_code !== "number") {
      bad.push(`candidate "${loc}": verdict "${verdict}" but the check has no recorded exit code`);
    } else {
      const held = predictionHeld(cand.predicted, cand.check_exit_code);
      const wanted = expectedVerdict(cand.predicted, cand.check_exit_code);
      if (verdict === VERDICT.VACUOUS ? !held : verdict !== wanted)
        bad.push(
          `candidate "${loc}": verdict "${verdict}" contradicts its own check (predicted ${cand.predicted}, exit ${cand.check_exit_code} ⇒ ${wanted})`,
        );
    }

    // A second run that disagreed cannot be filed as the original standing verdict.
    if (cand.verified_verdict != null && cand.verified_verdict !== verdict)
      bad.push(
        `candidate "${loc}": the second run said "${cand.verified_verdict}" — a claim that did not survive re-execution cannot be filed as "${verdict}"`,
      );

    // A control that also failed is no oracle at all.
    if (
      verdict === VERDICT.CONFIRMED &&
      typeof cand.control_exit_code === "number" &&
      cand.control_exit_code !== 0
    )
      bad.push(
        `candidate "${loc}": the control command also failed (exit ${cand.control_exit_code}) — bad oracle, it distinguishes nothing (rule 5)`,
      );

    // `confirmed` owes a discrimination receipt.
    if (
      verdict === VERDICT.CONFIRMED &&
      cand.control_exit_code !== 0 &&
      cand.probe_flipped !== "yes"
    )
      bad.push(
        `candidate "${loc}": "confirmed" with no discrimination receipt — run it with --control or --probe; a check that never touches the accused line agrees with any prediction (rule 5)`,
      );
    if (verdict === VERDICT.CONFIRMED && cand.probe_flipped === "no")
      bad.push(
        `candidate "${loc}": "confirmed" contradicts the non-flip (probe_flipped "no") — no sensitivity detected under this mutation`,
      );
    if (verdict === VERDICT.CONFIRMED && cand.predicted === "pass" && cand.probe_flipped !== "yes")
      bad.push(
        `candidate "${loc}": a pass prediction requires a flipped probe; a passed control alone cannot rule out an always-pass check`,
      );
    if (verdict === VERDICT.VACUOUS && cand.probe_flipped !== "no")
      bad.push(
        `candidate "${loc}": "inconclusive_vacuous" requires probe_flipped "no" — say what the probe showed, or use "inconclusive"`,
      );

    // The derived rating must clear the reportable floor before a cause is named.
    const floor = CAUSE_CONFIDENCE_FLOOR[VERDICT.CONFIRMED];
    const confidence = causeConfidence(cand);
    if (verdict === VERDICT.CONFIRMED && confidence < floor)
      bad.push(
        `candidate "${loc}": "confirmed" at cause_confidence ${confidence} is below the reportable floor ${floor} — add a discriminator (--control, --probe, --verify)`,
      );
  }
  return bad;
}

/**
 * Derived cause-confidence for a candidate: arithmetic over the receipts that
 * were actually recorded, never a self-report.
 *
 *   base             0.30  the prediction agreed with the executed check
 *   + control        0.20  a known-good path passed
 *   + probe flip     0.30  the check's outcome depends on the accused line
 *   + survived rerun 0.20  the claim held in a fresh process
 *
 * A candidate that is not `confirmed` contributes nothing: a demoted lead is
 * not a cause.
 */
export function causeConfidence(cand) {
  if (!cand || cand.verdict !== VERDICT.CONFIRMED) return 0;
  let score = 0.3;
  if (cand.control_exit_code === 0) score += 0.2;
  if (cand.probe_flipped === "yes") score += 0.3;
  if (cand.verified_verdict === VERDICT.CONFIRMED) score += 0.2;
  return Math.round(Math.min(1, score) * 100) / 100;
}

/** The confirmation that names the cause, if the case has one. */
export function confirmedCandidate(c) {
  return (c?.candidates ?? []).find((x) => x.verdict === VERDICT.CONFIRMED) ?? null;
}

/** What a case's cause-confidence is, and whether it may be reported. */
export function caseReportability(c) {
  const cand = confirmedCandidate(c);
  const confidence = cand ? causeConfidence(cand) : 0;
  const floor = CAUSE_CONFIDENCE_FLOOR[CASE_STATUS.CONFIRMED];
  const statusOk = REPORTABLE_STATUSES.has(c?.status);
  if (!statusOk)
    return { reportable: false, confidence, reason: `status "${c?.status}" is not reportable` };
  if (!cand)
    return { reportable: false, confidence, reason: 'no candidate has verdict "confirmed"' };
  if (confidence < floor)
    return {
      reportable: false,
      confidence,
      reason: `cause_confidence ${confidence} is below the floor ${floor}`,
    };
  return { reportable: true, confidence, reason: "" };
}

/**
 * Stable identity for a root cause, so a second investigation of the same fault
 * is a recurrence rather than a near-duplicate row. `key` is the readable tuple
 * for audit; `hash` is the index key.
 */
export function causeIdentity(c) {
  const cand = confirmedCandidate(c) ?? (c?.candidates ?? [])[0] ?? null;
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  const key = [
    norm(cand?.location),
    norm(cand?.hypothesis || c?.leading_hypothesis || c?.symptom || ""),
    norm(c?.reproduction?.command),
  ];
  const frames = (c?.reproduction?.stack ?? []).slice(0, 5).map(norm).join("\n");
  const hash = createHash("sha1")
    .update([...key, frames].join("|"))
    .digest("hex")
    .slice(0, 12);
  return { hash, key };
}

/**
 * E5 — why/evidence consistency (design v3 §1).
 *
 * The one schema field the hallucination literature flags hardest is the
 * free-text, procedural `why`. This is not semantic understanding: it flags a
 * `why` (or `hypothesis`) that cites a `file:line` which appears nowhere in the
 * case's own evidence — its candidate locations, its stack, or its covered
 * sites. A `why` that names no location is not making a checkable claim and
 * passes. The check is deliberately soft: it records rather than refuses, so the
 * violation rate (metric C9) can be measured before it gates anything.
 */
function basenameOf(p) {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop();
}

const LOCATION_REF = /([\w./\\-]+\.[A-Za-z0-9]+):(\d+)/g;

export function whyViolations(c) {
  const evidence = new Set();
  const add = (file, line) => {
    if (file && line != null) evidence.add(`${basenameOf(file)}:${line}`);
  };
  for (const cand of c?.candidates ?? []) {
    for (const m of String(cand.location ?? "").matchAll(LOCATION_REF)) add(m[1], m[2]);
  }
  for (const frame of c?.reproduction?.stack ?? []) {
    for (const m of String(frame).matchAll(LOCATION_REF)) add(m[1], m[2]);
  }
  for (const site of c?.reproduction?.covered ?? []) add(site.file, site.line);

  const out = [];
  for (const cand of c?.candidates ?? []) {
    for (const field of ["why", "hypothesis"]) {
      const text = cand?.[field];
      if (!text) continue;
      for (const m of String(text).matchAll(LOCATION_REF)) {
        const ref = `${m[1]}:${m[2]}`;
        if (!evidence.has(`${basenameOf(m[1])}:${m[2]}`))
          out.push(
            `candidate "${cand.location}": ${field} references ${ref}, which is not in this case's stack, covered sites, or candidate locations`,
          );
      }
    }
  }
  return out;
}

/**
 * True when a value set covers a canonical set exactly. The parity guard that
 * keeps the schema enums and this module from drifting apart.
 */
export function alignedWith(values, canonical) {
  return (
    values != null &&
    new Set(values).size === canonical.length &&
    canonical.every((v) => values.includes(v))
  );
}
