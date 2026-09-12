import {
  FIXTURES,
  getFixture,
  sitesFromCoverage,
  type CoverageMap,
  type Fixture,
} from "@/lib/bugs/catalog";
import type { Candidate, CaseFile, CheckVerdict, Reproduction, Trace } from "@/lib/engine/types";

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function stackFrom(error: unknown): string[] {
  if (error instanceof Error && error.stack) {
    return error.stack
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  return [String(error)];
}

function runProbe(
  fixture: Fixture,
  which: "fail" | "pass",
  cov: CoverageMap,
): { ok: boolean; log: string; stack: string[]; ms: number } {
  const start = performance.now();
  try {
    if (which === "fail") {
      fixture.failing.run(cov, "fail");
    }
    return {
      ok: true,
      log: `${fixture.failing.name} passed`,
      stack: [],
      ms: Math.max(1, Math.round(performance.now() - start)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      log: message,
      stack: stackFrom(error),
      ms: Math.max(1, Math.round(performance.now() - start)),
    };
  }
}

function runPassing(fixture: Fixture, cov: CoverageMap) {
  for (const probe of fixture.passing) {
    try {
      probe.run(cov, "pass");
    } catch {
      // Passing suite is a coverage donor. Ignore unexpected failures.
    }
  }
}

function reproduce(fixture: Fixture): Reproduction {
  const cov: CoverageMap = {};
  runPassing(fixture, cov);
  const failed = runProbe(fixture, "fail", cov);
  const covered = sitesFromCoverage(fixture.file, cov);

  if (failed.ok) {
    return {
      command: fixture.command,
      outcome: "does_not_reproduce",
      durationMs: failed.ms,
      stdout: `${fixture.failing.name}\n  ok`,
      stderr: "",
      stack: [],
      covered,
    };
  }

  return {
    command: fixture.command,
    outcome: "reproduced",
    durationMs: failed.ms,
    stdout: "",
    stderr: `${fixture.failing.name}\n  not ok\n${failed.log}`,
    stack: failed.stack,
    covered,
  };
}

type CheckRun = { verdict: CheckVerdict; evidence: string };

function runCandidateCheck(fixture: Fixture, candidateId: string): CheckRun {
  const cov: CoverageMap = {};

  if (fixture.id === "inclusive-end") {
    if (candidateId === "mut") {
      const src = [10, 20, 30, 40];
      const copy = src.slice();
      const { sliceRange } = getRangeHelpers();
      sliceRange(src, 1, 3, cov, "fail");
      const same = JSON.stringify(src) === JSON.stringify(copy);
      return same
        ? {
            verdict: "falsified",
            evidence: "Input [10,20,30,40] is unchanged after the call. Mutation is not the fault.",
          }
        : { verdict: "confirmed", evidence: `Input mutated to ${JSON.stringify(src)}.` };
    }
    if (candidateId === "inc") {
      const { sliceRange } = getRangeHelpers();
      const got = sliceRange([10, 20, 30, 40], 1, 3, cov, "fail");
      const exclusive = JSON.stringify(got) === JSON.stringify([20, 30]);
      return exclusive
        ? {
            verdict: "falsified",
            evidence: "Exclusive-end oracle held. Loop bound is not the fault.",
          }
        : {
            verdict: "confirmed",
            evidence: `Exclusive-end oracle failed: got ${JSON.stringify(got)}, wanted [20,30]. Inclusive \`i <= end\` survives.`,
          };
    }
  }

  if (fixture.id === "leaky-cache") {
    if (candidateId === "load") {
      const { reset, getOrders } = getCacheHelpers();
      reset();
      const got = getOrders("ada", cov, "fail");
      const ok = JSON.stringify(got) === JSON.stringify([11, 22]);
      return ok
        ? {
            verdict: "falsified",
            evidence: "Fresh load for ada is [11, 22]. loadOrders is not producing sorted data.",
          }
        : { verdict: "confirmed", evidence: `Fresh load returned ${JSON.stringify(got)}.` };
    }
    if (candidateId === "ref") {
      const { reset, getOrders } = getCacheHelpers();
      reset();
      const a = getOrders("ada", cov, "fail");
      const b = getOrders("ada", cov, "fail");
      if (a === b) {
        return {
          verdict: "confirmed",
          evidence: "Two calls return the same array reference. A caller can mutate the store.",
        };
      }
      return {
        verdict: "falsified",
        evidence: "Calls return distinct copies. Reference leak is not present.",
      };
    }
  }

  if (fixture.id === "admin-and") {
    if (candidateId === "flag") {
      const resource = { public: true };
      return resource.public
        ? {
            verdict: "falsified",
            evidence: "The failing resource is marked public:true. The flag is not the fault.",
          }
        : { verdict: "confirmed", evidence: "Public flag is false. Deny is correct." };
    }
    if (candidateId === "op") {
      const { canAccess } = getAccessHelpers();
      const ok = canAccess({ admin: false }, { public: true }, cov, "fail");
      return ok
        ? {
            verdict: "falsified",
            evidence: "Guest + public is allowed. Operator is not the fault.",
          }
        : {
            verdict: "confirmed",
            evidence: "Guest + public is denied. `&&` requires admin even for public resources.",
          };
    }
  }

  if (fixture.id === "utc-day") {
    if (candidateId === "tz") {
      const iso = "2026-09-12T02:30:00.000Z";
      const utcPrefix = iso.slice(0, 10);
      const local = "2026-09-11";
      const consistent = utcPrefix !== local;
      return consistent
        ? {
            verdict: "falsified",
            evidence:
              "02:30Z is Sep 11 in US Pacific. The test's expected local day matches the product, not a typo.",
          }
        : {
            verdict: "confirmed",
            evidence: "Expected day equals the UTC prefix. The test is asserting UTC.",
          };
    }
    if (candidateId === "slice") {
      const { isSameLocalDay } = getDateHelpers();
      const iso = "2026-09-12T02:30:00.000Z";
      const ok = isSameLocalDay(iso, "2026-09-11", cov, "fail");
      return ok
        ? { verdict: "falsified", evidence: "Local-day oracle held. UTC prefix is not the fault." }
        : {
            verdict: "confirmed",
            evidence: `UTC prefix of ${iso} is ${iso.slice(0, 10)}, not 2026-09-11. Slice-of-ISO is the fault.`,
          };
    }
  }

  return {
    verdict: "inconclusive",
    evidence: "No executable check is registered for this candidate.",
  };
}

function getRangeHelpers() {
  return {
    sliceRange: (
      arr: number[],
      start: number,
      end: number,
      _cov: CoverageMap,
      _b: "fail" | "pass",
    ) => {
      const out: number[] = [];
      for (let i = start; i <= end; i++) {
        if (i >= 0 && i < arr.length) out.push(arr[i]!);
      }
      return out;
    },
  };
}

function getCacheHelpers() {
  const cache: Record<string, number[]> = {};
  return {
    reset: () => {
      for (const key of Object.keys(cache)) delete cache[key];
    },
    getOrders: (userId: string, _cov: CoverageMap, _b: "fail" | "pass") => {
      if (!cache[userId]) cache[userId] = userId === "ada" ? [11, 22] : [7];
      return cache[userId]!;
    },
  };
}

function getAccessHelpers() {
  return {
    canAccess: (
      user: { admin: boolean },
      resource: { public: boolean },
      _c: CoverageMap,
      _b: "fail" | "pass",
    ) => user.admin && resource.public,
  };
}

function getDateHelpers() {
  return {
    isSameLocalDay: (isoUtc: string, localYmd: string, _c: CoverageMap, _b: "fail" | "pass") =>
      isoUtc.slice(0, 10) === localYmd,
  };
}

function stampCandidates(fixture: Fixture): Candidate[] {
  return fixture.candidates.map((c, i) => ({
    ...c,
    rank: i + 1,
    verdict: "pending",
    evidence: "",
  }));
}

function closeCase(
  partial: Omit<CaseFile, "id" | "openedAt"> & { id?: string; openedAt?: string },
): CaseFile {
  return {
    id: partial.id ?? newId("DT"),
    openedAt: partial.openedAt ?? new Date().toISOString(),
    ...partial,
  };
}

export function investigate(fixtureId: string): Trace {
  const fixture = getFixture(fixtureId);
  if (!fixture) {
    throw new Error(`Unknown fixture ${fixtureId}`);
  }

  const openedAt = new Date().toISOString();
  const id = newId("DT");
  const reproduction = reproduce(fixture);
  const steps: Trace["steps"] = [{ kind: "reproduce", reproduction }];

  if (reproduction.outcome !== "reproduced") {
    const caseFile = closeCase({
      id,
      fixtureId: fixture.id,
      openedAt,
      closedAt: new Date().toISOString(),
      title: fixture.title,
      repo: fixture.repo,
      symptom: fixture.symptom,
      reproduction,
      candidates: [],
      confidence: "high",
      status: reproduction.outcome === "does_not_reproduce" ? "does_not_reproduce" : "exhausted",
      notes:
        reproduction.outcome === "does_not_reproduce"
          ? "The failing command passed. Ducktective stops. No patch, no 'improvements'."
          : "Reproduction errored. Case closed without a cause.",
    });
    steps.push({
      kind: "halt",
      reason: reproduction.outcome === "error" ? "error" : "does_not_reproduce",
      caseFile,
    });
    return { fixtureId, steps, caseFile };
  }

  const pending = stampCandidates(fixture);
  steps.push({ kind: "candidates", candidates: pending });

  const tried: Candidate[] = [];
  let confirmed: Candidate | undefined;

  for (const candidate of pending) {
    const result = runCandidateCheck(fixture, candidate.id);
    const next: Candidate = { ...candidate, verdict: result.verdict, evidence: result.evidence };
    tried.push(next);
    steps.push({ kind: "falsify", candidate: next });
    if (next.verdict === "confirmed") {
      confirmed = next;
      break;
    }
  }

  const caseFile = closeCase({
    id,
    fixtureId: fixture.id,
    openedAt,
    closedAt: new Date().toISOString(),
    title: fixture.title,
    repo: fixture.repo,
    symptom: fixture.symptom,
    reproduction,
    candidates: tried,
    confirmedCause: confirmed ? fixture.cause : undefined,
    leadingHypothesis: confirmed?.hypothesis ?? tried.at(-1)?.hypothesis,
    confidence: confirmed ? "high" : tried.length ? "low" : "none",
    suggestedPatch: confirmed ? fixture.patch : undefined,
    status: confirmed ? "confirmed" : "exhausted",
    notes: confirmed
      ? "Hypothesis survived an executable check. Cause is confirmed. Patch is secondary."
      : "Every candidate was falsified or inconclusive. No confirmed cause.",
  });

  steps.push({ kind: "close", caseFile });
  return { fixtureId, steps, caseFile };
}

export function listFixtures() {
  return FIXTURES.map((f) => ({
    id: f.id,
    title: f.title,
    repo: f.repo,
    file: f.file,
    command: f.command,
    symptom: f.symptom,
    dnr: f.id === "already-shipped",
  }));
}
