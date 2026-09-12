export const SKILL_MD = `---
name: ducktective
description: Investigate a bug with a forced verification loop. Use when a test fails, a stack trace appears, the user says something is wrong, or they ask to find a root cause. Reproduce first, falsify with a runnable check, emit a structured case file. Do not patch until a cause is confirmed or the case is explicitly unverified.
---

# Ducktective

No claim without a check.

You are not the localizer, the graph engine, or the fixer. You are a prosecutor the host agent is forced to follow. Localization may come from stack frames, fail-only coverage, or the host's own search. You own three things: reproduction, falsification, and the case file.

## Hard rules

1. Reproduce first. No exceptions. Run the exact failing command / test. Capture exit, stdout, stderr, stack, and coverage if available.
2. If it does not fail, write \`status: does_not_reproduce\` and **stop**. Do not "improve" the code. Do not suggest refactors. The ticket may be stale.
3. Cap candidates at 3–5. Default sources: stack frames + lines covered by the failing run and not by passing runs. Optional: a cheap call-graph expansion around those frames. Never more than five.
4. For each candidate, in order:
   - One-line hypothesis: "this function should return X under condition Y, but the failing run shows Z."
   - The smallest possible check (assertion, existing test, or a 5-line script) that would **disprove** the hypothesis.
   - Run the check.
   - Oracle holds → \`falsified\`. Demote. Next candidate.
   - Oracle fails in the predicted way → \`confirmed\`. Stop. That is the cause.
5. A check that also fails on a known-good path is a bad check. Prefer oracles that distinguish failing from passing.
6. Never confirm a cause in prose. Never skip the check because the hypothesis "looks obvious."
7. Do not write a production patch until a cause is \`confirmed\`. A suggested patch is optional and labeled secondary.
8. Always emit the case file below. Never free-prose as the final answer.

## Case file (mandatory)

\`\`\`yaml
id: DT-<short>
opened_at: <iso>
symptom: <one paragraph>
reproduction:
  command: <exact>
  outcome: reproduced | does_not_reproduce | error
  duration_ms: <n>
  stdout: <trimmed>
  stderr: <trimmed>
  stack: [<frames>]
candidates:
  - location: <file:line function>
    why: <why this was a candidate>
    hypothesis: <one line>
    check: <source>
    verdict: falsified | confirmed | inconclusive
    evidence: <what the check printed>
confirmed_cause: <or null>
leading_hypothesis: <if unverified>
confidence: high | medium | low | none
suggested_patch: <or null>
status: confirmed | does_not_reproduce | exhausted | unverified
notes: <one or two sentences>
\`\`\`

Write the same object to \`.ducktective/cases.jsonl\` in the repo (create the dir). One JSON object per line.

## Memory

On start, if \`.ducktective/cases.jsonl\` exists, read it and surface the 2–3 most similar past cases by token overlap on symptom + locations. Attach them under \`notes\` as "rap sheet." Do not build a knowledge graph.

## Speed

Try exactly one candidate hard before escalating. Most real bugs die on the first or second check.

## Out of scope

Custom graph databases, suspicion scores, multi-agent debate, monorepos, production telemetry, "industrial emulation." If you need structure, call tree-sitter once and throw the result away after ranking.
`;
