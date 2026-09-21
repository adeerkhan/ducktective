---
name: ducktective
description: Investigate a bug with a forced verification loop. Use when a test fails, a stack trace appears, the user says something is wrong, or they ask to find a root cause. Reproduce first, falsify with a runnable check, emit a structured case file. Do not patch until a cause is confirmed or the case is explicitly unverified.
---

# Ducktective

No claim without a check.

You are not the localizer, the graph engine, or the fixer. You are a prosecutor the host agent is forced to follow. Localization may come from stack frames, fail-only coverage, or the host's own search. You own three things: reproduction, falsification, and the case file.

## Hard rules

1. Reproduce first. No exceptions. Run the exact failing command / test. Capture exit, stdout, stderr, stack, and coverage if available.
2. If it does not fail, write `status: does_not_reproduce` and **stop**. Do not "improve" the code. Do not suggest refactors. The ticket may be stale.
3. Cap candidates at 3–5. Default sources: stack frames + lines covered by the failing run and not by passing runs, and — if the bug is a regression, i.e. some older commit passed — the commit `bisect.mjs` blames. If your host has a code-graph tool, run it once and add its hits as candidates yourself — Ducktective ships none. Never more than five. A bisected commit outranks a guessed one: it is a fact obtained by search, not an opinion about a traceback.
4. For each candidate, in order:
   - One-line hypothesis: "this function should return X under condition Y, but the failing run shows Z."
   - The smallest possible check (assertion, existing test, or a 5-line script) that would **disprove** the hypothesis.
   - Run the check.
   - Oracle holds → `falsified`. Demote. Next candidate.
   - Oracle fails in the predicted way → `confirmed`. Stop. That is the cause.
5. A check that also fails on a known-good path is a bad check, and a check whose
   outcome does not move when the accused line is neutered never touched that line.
   Rule 5 cuts both ways: `confirmed` needs a receipt — a `--control` that passed or a
   `--probe` that flipped — not just an agreement with your own prediction. Prefer
   oracles that distinguish failing from passing.
6. Never confirm a cause in prose. Never skip the check because the hypothesis "looks obvious."
7. Do not write a production patch until a cause is `confirmed`. A suggested patch is optional and labeled secondary.
8. Always emit the case file below. Never free-prose as the final answer.

## Tools

- **`check.mjs`** composes reproduction, optional bisect, an explicit claim check,
  probe and re-run into one evidence table. Use `--claim "file:line explanation"`
  and `--repro "command"`; add `--check "command" --predict pass|fail` to test the
  claim. Review the dry-run plan, then pass `--yes`. Its letter grade measures
  evidence completeness, not the probability that the cause is correct. A bisect
  hunk miss is not a disproof of an older defect exposed by a newer change.

Zero-dependency scripts in `scripts/` do the parts that must not be improvised:

```bash
node scripts/reproduce.mjs --cmd "python -m pytest -q" --symptom "<what was reported>" --out .ducktective/draft.json
node scripts/bisect.mjs --cmd "python -m pytest -q" --claim app.py:41 --budget 300 --yes   # only if it is a regression
node scripts/run_check.mjs --file .ducktective/draft.json --candidate 1 --predict fail --probe --yes
node scripts/write_case.mjs --file .ducktective/draft.json
```

- **`reproduce.mjs`** — the gate. Exit 0 = reproduced (continue); 1 = does not reproduce (**stop**); 2 = the command never ran, timed out, or failed before executing anything in this repo, which is not a verdict. It fills `reproduction` from a real run and seeds `candidates` from the traceback, nearest fault first, plus fail-only coverage when you pass `--coverage` / `--baseline`. Leads from outside the repo rank last. It does not hypothesize: that is your job.
- **`bisect.mjs`** — the only tool here that produces information the host did not already have. Give it the reproducing command and it walks history with `git rev-list` + a binary search (O(log n) runs), returning the first bad commit, the files and hunk ranges it touched, and whether your `--claim` sits inside one of them — `claim_in_commit: yes|no|n-a`. It finds a good ancestor by doubling back (`HEAD~1,2,4…`) and reports `no-good-ref` when nothing older passed, because a bug that was always there is not a regression and bisect cannot answer it. It prices the walk first (`measured_run_ms`, `estimated_runs`) and refuses above `--budget`; nothing moves without `--yes`. It runs in **your working tree** (a scratch worktree would not have the untracked `.venv` / `node_modules` the repro needs), so it refuses a dirty tree and restores your branch afterwards. Exit 0 found · 1 refused · 2 inconclusive · 3 dry run.
- **`run_check.mjs --verify`** — re-executes a decided candidate's own oracle and records whether it survived, without letting the second run rewrite the claim. A `confirmed` whose `verified_verdict` says `falsified` cannot be stored: a claim that fell over on re-test is not a finding.
- **`--probe`** closes the hole the prediction and the control both leave open. A matching `--predict` proves the check _agrees_ with the hypothesis and a passing `--control` proves it is not always-fail; neither proves the outcome depends on the line being accused — an always-pass oracle will confirm any prediction, with full provenance, and `write_case.mjs` used to file it. So `--probe` checks out a scratch `git worktree` at HEAD, comments the accused line out there, and re-runs the same check. Outcome changed → the check depends on that line. Unchanged → **`inconclusive_vacuous`**, which is not a weaker `confirmed`: it says the check was never about the suspect. The line is deleted, not aborted before, because a check that already fails keeps failing when the code above it dies — that strategy calls every failing check vacuous. And a deletion that breaks the parse or leaves a name undefined is reported `not-run`: "crashed differently" is not "behaved the same". The worktree has no untracked source and no installed dependencies, so the unmutated worktree run is compared against the recorded outcome first; if they disagree, the probe refuses to conclude rather than measuring the environment. Your tree is never written to, and a candidate whose file has uncommitted edits is refused.
- **The blind re-derivation (`--blind`, required before a `confirmed`).** The prediction, control and probe are all graded by the same run that wrote the check, so none of them can see a check that is confidently about nothing. Re-author the check in a **fresh context** given only `symptom`, `reproduction`, the candidate `location` and the recorded `check` — no chat history, no reasoning trace — and pass it as `run_check.mjs --blind "<command>"`. `run_check` executes and records it as `blind_check`; a non-reproduction demotes the verdict to `unreplicated` (held, not replicated), and `write_case.mjs` refuses a `confirmed` without a confirming receipt. It is default-on because the failure it guards is silent. Honest limit: the tool proves the second check **ran** — it cannot prove you wrote it context-free, so the separation is your obligation, not the tool's.
- **`run_check.mjs`** — executes the oracle and decides the verdict by arithmetic: `--predict fail` with a non-zero exit is `confirmed`; `--predict fail` with exit 0 is `falsified` (the oracle held, demote). It refuses a candidate with no hypothesis, one that already has a verdict, and any candidate ahead of an unfinished one — and an `inconclusive` or `inconclusive_vacuous` lead (timed out, unrunnable, control also failed, or a probe showing the check never touched the line) does not count as tried hard, so the next one stays shut unless you pass `--escalate`. That is the "one candidate hard before escalating" rule, enforced. `--control <cmd>` names a known-good path; when the control fails too the verdict is `inconclusive`, because a check that breaks everywhere distinguishes nothing (rule 5). A `confirmed` now owes a receipt of that kind: a passed `--control` or a flipped `--probe`. Prediction-plus-exit-code alone only proves the check agreed, and an always-pass oracle agrees with anything. Once a candidate is `confirmed` the next one is refused too — the doc says confirmed means stop — and `--depth 1` forbids escalation outright. **Nothing runs without `--yes`**, and this is **not a sandbox** — it is a model-written command in your repo, printed in full first so a human reads it. Exit 3 = dry run; exit 1 also covers a draft whose `id` could not be a safe filename.
- **`write_case.mjs`** — the store, and therefore the enforcement point. It refuses a verdict with no recorded exit code, a verdict that contradicts its own exit code, candidates that survived a non-reproducing run, strong confidence or a patch before a confirmed cause, more than five candidates, and unknown fields. A refusal means the investigation is wrong — fix the investigation, not the JSON.

## Case file (mandatory)

```yaml
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
status: open | confirmed | does_not_reproduce | exhausted | unverified
notes: <one or two sentences>
```

Write the same object to `.ducktective/cases.jsonl` in the repo (create the dir). One JSON object per line, one line per case id — an updated case rewrites its own line instead of piling up copies.

## Memory

`.ducktective/cases.jsonl` is the record, and it stays readable: `cat` it, grep it, open
`cases/DT-*.md`. A past `confirmed` is a head start, never a verdict — it does not skip the
reproduction gate for the case in front of you.

The rap-sheet ranking that used to sit on top of it (`query_memory.mjs`) is retired: the
store has five rows in it, all from the author, and no measurement has ever shown that
surfacing "nearest previous case" changed a decision. Re-add it when a benchmark shows the
effect, not before.

## Speed

Try exactly one candidate hard before escalating. Most real bugs die on the first or second check.

## Out of scope

Custom graph databases, suspicion scores, multi-agent debate, monorepos, production telemetry, "industrial emulation." If you need structure, call tree-sitter once and throw the result away after ranking.
