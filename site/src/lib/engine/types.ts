export type ReproductionOutcome = "reproduced" | "does_not_reproduce" | "error";

export type CheckVerdict = "pending" | "falsified" | "confirmed" | "inconclusive";

export type CaseStatus =
  | "open"
  | "confirmed"
  | "does_not_reproduce"
  | "exhausted"
  // Canonical statuses come from skills/ducktective/case-file.schema.json —
  // `unverified` is where an investigation with no confirmed cause has to land.
  | "unverified";

export type Confidence = "high" | "medium" | "low" | "none";

export type CoveredSite = {
  id: string;
  file: string;
  label: string;
  failHits: number;
  passHits: number;
};

export type Reproduction = {
  command: string;
  outcome: ReproductionOutcome;
  durationMs: number;
  /** What the process actually returned — the difference between a verdict and a mood. */
  exitCode?: number | null;
  /** Which runner produced the traceback, so the reader knows how to re-run it. */
  runner?: "pytest" | "unittest" | "node-test" | "unknown";
  stdout: string;
  stderr: string;
  stack: string[];
  covered: CoveredSite[];
};

export type Candidate = {
  id: string;
  rank: number;
  location: string;
  why: string;
  hypothesis: string;
  checkName: string;
  checkSource: string;
  verdict: CheckVerdict;
  evidence: string;
  /**
   * Oracle provenance, from run_check.mjs: what the hypothesis predicted, what
   * the process returned, and the known-good control that made the check mean
   * something. Without these the sheet shows a verdict with no way to audit it.
   */
  predicted?: "pass" | "fail";
  checkExitCode?: number | null;
  control?: string;
  controlExitCode?: number | null;
};

export type CaseFile = {
  id: string;
  fixtureId: string;
  openedAt: string;
  closedAt?: string;
  title: string;
  repo: string;
  symptom: string;
  reproduction: Reproduction;
  candidates: Candidate[];
  confirmedCause?: string;
  leadingHypothesis?: string;
  confidence: Confidence;
  suggestedPatch?: string;
  status: CaseStatus;
  notes: string;
};

export type InvestigationStep =
  | { kind: "reproduce"; reproduction: Reproduction }
  | { kind: "halt"; reason: "does_not_reproduce" | "error"; caseFile: CaseFile }
  | { kind: "candidates"; candidates: Candidate[] }
  | { kind: "falsify"; candidate: Candidate }
  | { kind: "close"; caseFile: CaseFile };

export type Trace = {
  fixtureId: string;
  steps: InvestigationStep[];
  caseFile: CaseFile;
};
