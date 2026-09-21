---
name: ducktective
description: Find the root cause of a failing command and prove it before you patch. Use when a test fails, CI is red, a stack trace or error appears, something that worked stopped working, or the user asks to find a root cause.
---

# Ducktective

No claim without a check. You are not the fixer: you own **reproduction, falsification, and the case file**. Localization may come from stack frames, coverage, or your own search.

## When to use

- a test fails, CI is red, or a build breaks
- a stack trace or error appears and the cause is not obvious
- something worked before and stopped (a regression)
- the user asks "why is this failing" / "find the root cause"

Not for: implementing a fix whose cause is already known, refactors, or new features.

## Workflow

### 1. Reproduce

Run the exact failing command. Do not guess, and do not fix anything yet.

```bash
node scripts/reproduce.mjs --cmd "<failing command>" --symptom "<what was reported>" --out .ducktective/draft.json
```

| exit | outcome              | next                                                                |
| ---- | -------------------- | ------------------------------------------------------------------- |
| 0    | reproduced           | step 2                                                              |
| 1    | `does_not_reproduce` | **stop** — the ticket may be stale; write the case and hand it back |
| 2    | `error`              | the command never ran in this repo — fix the command, not the code  |

`draft.json` now holds the reproduction and seeded `candidates`: traceback frames nearest the fault, plus fail-only coverage when you pass `--coverage` / `--baseline`. If your host has a code-graph tool, run it once and add its hits yourself — Ducktective ships none. **Never more than five candidates.**

### 2. Bisect — only if it is a regression

If an older commit passed, find where it broke. `bisect.mjs` walks history in O(log n) runs, prices the walk first, and needs `--yes`.

```bash
node scripts/bisect.mjs --cmd "<failing command>" --claim <file:line> --budget 300 --yes
```

A blamed commit outranks a guessed one — it is a fact from search, not an opinion about a traceback. If nothing older passed (`no-good-ref`), skip this step: a bug that was always there is not a regression.

### 3. Falsify — one candidate at a time

For the top candidate in `draft.json`:

1. State a one-line hypothesis: "this function should return X under Y, but the failing run shows Z."
2. Write the smallest check that would **disprove** it — an assertion, an existing test, or a short script. Prefer a check that distinguishes the failing path from a known-good one.
3. Run it with a control:

```bash
node scripts/run_check.mjs --file .ducktective/draft.json --candidate 1 \
  --predict fail \
  --cmd "<the check>" \
  --control "<known-good command that must pass>" \
  --yes
```

| verdict                | meaning                                                              | next                                 |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| `confirmed`            | failed as predicted, and a `--control` passed or a `--probe` flipped | **stop** — this is the cause         |
| `falsified`            | the check held; the hypothesis is wrong                              | next candidate                       |
| `inconclusive_vacuous` | the check did not move when the accused line was neutered            | it never touched that line — rewrite |
| `inconclusive`         | timed out, could not run, or the control failed too                  | fix the check                        |
| `unreplicated`         | a `--blind` check ran and did not reproduce the claim                | rewrite the blind check, or file it  |

`--control` names a known-good path that must pass — a check that fails everywhere distinguishes nothing. Add `--probe` (neuters the accused line on a scratch `git worktree`) and `--blind` (executes a second, independently written check) when the cause must be **reportable**, the merge-grade you would put in a review. Without `--yes` the tools print the exact commands and stop.

**Two grades.** `confirmed` — the prediction held and a receipt discriminated (control or probe); act on it now. **reportable** — `confirmed` plus an _independent_ receipt (a probe flip, a confirming blind check, or a survived verify); that is the merge-grade cause.

**Try one candidate hard before escalating.** An `inconclusive` lead does not unlock the next; pass `--escalate` only to move on knowingly.

### 4. Emit the case file

```bash
node scripts/write_case.mjs --file .ducktective/draft.json
```

Writes `.ducktective/cases.jsonl` (one line per case, updated in place) and a Markdown mirror `.ducktective/cases/<id>.md`. **A refusal means the investigation is wrong — fix the investigation, not the JSON.**

### One-shot alternative

`check.mjs` composes the loop into one graded command:

```bash
node scripts/check.mjs --claim "<file:line> <what it says>" --repro "<failing command>" \
  --check "<disproving check>" --predict fail --control "<known-good>" --blind "<second check>" --yes
```

It prints an evidence table and a letter grade. The grade measures evidence completeness, not whether the cause is right.

## Hard rules

1. Reproduce first. No exceptions: run the exact failing command and capture exit, output, stack, and coverage if available.
2. If it does not fail, write `status: does_not_reproduce` and **stop**. Do not "improve" the code or suggest refactors.
3. Cap candidates at 3–5, never more. A bisected commit outranks a guessed one.
4. For each candidate, in order: state a one-line hypothesis; write the smallest check that would disprove it; run it. Oracle holds → `falsified`, demote, next candidate. Oracle fails in the predicted way → `confirmed`, stop.
5. A check that also fails on a known-good path is a bad check, and a check whose outcome does not move when the accused line is neutered never touched that line. `confirmed` needs a discrimination receipt — a `--control` that passed or a `--probe` that flipped. A **reportable** (merge-grade) cause also needs an independent receipt: a `--probe` flip, a confirming `--blind`, or a survived `--verify`.
6. Never confirm a cause in prose, and never skip the check because the hypothesis "looks obvious."
7. Do not write a production patch until a cause is `confirmed`. A suggested patch is secondary.
8. Always emit the case file. Never free-prose as the final answer.

## Case file

```yaml
id: DT-<short>
opened_at: <iso>
symptom: <one paragraph>
reproduction: { command, outcome, duration_ms, stdout, stderr, stack, covered, runner }
candidates:
  - {
      location: <file:line function>,
      why,
      hypothesis,
      check,
      predicted,
      check_exit_code,
      verdict,
      evidence,
    }
confirmed_cause: <or null>
leading_hypothesis: <if unverified>
confidence: high | medium | low | none
suggested_patch: <or null>
status: open | confirmed | does_not_reproduce | exhausted | unverified
notes: <one or two sentences>
```

The full shape is `case-file.schema.json` beside this file.

## Memory

`.ducktective/cases.jsonl` is the record; `cat` it, grep it, open `cases/DT-*.md`. A past `confirmed` is a head start, never a verdict — it does not skip the reproduction gate for the case in front of you.

## Common rationalizations

| Rationalization                    | Reality                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| "The cause is obvious, skip it."   | Obvious causes are wrong often enough to matter. Run the check.                                                   |
| "The test is wrong, not the code." | Verify that. If the test is wrong, fix the test — don't silently skip it.                                         |
| "It passes locally."               | Reproduce with the same command and environment, or say `does_not_reproduce`.                                     |
| "The check agreed, so confirmed."  | Agreement is not discrimination. A `--control` (or `--probe`) is required; add `--blind` for a merge-grade cause. |
| "I'll write the case later."       | The case file is the deliverable. Later is never.                                                                 |

## Red flags

- a verdict with no executed check, or a `check_exit_code` typed by hand
- `confirmed` with no control, no probe, or no blind receipt
- a patch proposed before a confirmed cause
- escalating past a candidate that was never tested
- more than five candidates

## Verification

- [ ] `reproduce.mjs` ran the exact command and recorded the outcome
- [ ] every candidate carried a hypothesis and an executed check
- [ ] `confirmed` carries a discrimination receipt; a reportable cause carries an independent one too
- [ ] `.ducktective/cases.jsonl` and the Markdown mirror were written

## Out of scope

Custom graph databases, suspicion scores, multi-agent debate, production telemetry. If you need structure, call tree-sitter once and throw the result away after ranking.
