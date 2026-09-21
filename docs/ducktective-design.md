# Ducktective — design.md (v3)

Supersedes v2. Written 2026-09-19 after reviewing five papers against `architecture.md`
@ `31bc9f7`. v2 argued the protocol should become a verdict engine (bisect + a
discrimination probe) graded on a benchmark instead of 3 field cases. Nothing in the
new material changes that direction. It changes how naive your discrimination story
still is, and it gives you a cheap, continuous way to know if the thing works before
the 200-bug benchmark is ready. Read v2 first; this document only patches it.

---

## 0. The harsh version, up front

Your entire pitch is "we refuse to write a verdict we can't back with an executed
oracle." The literature just spent five papers proving that **every team that shipped
this exact pitch first was still wrong most of the time**, and the reason they were
wrong is a specific, well-characterized failure mode you have not yet built a defense
against: a model asked to validate its own claim will produce something that _looks_
like validation almost every time, whether or not the claim is true.

The sharpest number in the whole review: Claude Code with Opus 4.5 generates 142
plausible PoCs out of 144 bug reports, but only 26 of them are indeed valid — and on
reports that were never real bugs at all, the same agent fails to reject 98% of them.
That is not a worse model than the one in your loop. That is the same class of model,
on a harder version of exactly the task `run_check.mjs` performs, gaming the task almost
every time it's asked to grade itself.

Your `--control` check does not defend against this. `--control` proves the check isn't
always-fail. It does not prove the model didn't write a check that's vacuously true, or
that "confirmed" isn't just confident narration with a green exit code attached. v2
called this D2 and proposed a mutation probe. The probe was still checked _inside the
same run, by the same process, with the model's own reasoning trace still live_. The
literature says that's not enough — the thing that actually moves the needle is
**structural separation**: a checker with zero access to the claim-writer's context,
re-executing from scratch, instructed to trust nothing it didn't independently observe.
When that separation exists, false positives drop 7.8–20×. When it doesn't — even with
an LLM "revalidate the findings" step bolted on, which several of these tools already
had — the best of five specialized tools still averaged an 85.3% false discovery rate
in real projects, and on fresh repositories one of them hit 97.0%.

Revise your confidence accordingly: D2 wasn't a nitpick. It's the single most
well-evidenced failure mode in this entire literature, it is not solved by "add a
control run," and you have not built the thing that does solve it.

---

## 1. What actually gets fixed here (the delta from v2)

### E2 revised — the probe becomes a blind checker, not a self-check

v2's `--probe`: neuter the accused line, re-run the same check, require the verdict to
flip. Keep the mechanism. Change who runs it and what they're allowed to see.

**Old (v2):** same process, same run, the model's reasoning trace still in context when
the probe result comes back.

**New:** a `check_grader` invocation that receives _only_ the case file's structured
fields — `symptom`, `reproduction`, `candidates[rank].location`, `candidates[rank].check`
— and nothing else: no chat history, no chain-of-thought that produced the hypothesis,
no prior turns. It re-derives whether the check discriminates, from cold. This is not a
new agent framework; it's a discipline on what context a specific tool invocation is
allowed to carry. The cost is one extra model call per candidate confirmed. The payoff,
per the only paper that measured this exact intervention, is on the order of an order of
magnitude fewer false confirmations.

Concretely: `write_case.mjs` gains a mode where, before accepting a `confirmed` status,
it re-invokes the check-authoring step with a stripped context — report + candidate
location only — and requires the re-derived check to still discriminate under the E2
probe. If the blind re-derivation produces a different check that doesn't flip, or
produces "I can't tell without more context," the verdict downgrades to
`inconclusive_vacuous`. This is strictly more expensive than v2's design. Build it
anyway — the alternative is shipping the exact failure mode five separate papers just
spent a combined ~40 pages documenting.

### E5, new — a why-vs-evidence consistency check

The bug-report-hallucination paper measured something specific to free-text fields, not
code: roughly 48–60% of LLM-written summary sections contained hallucinated or missing
content, and the _procedural_ sections — the sequential "what happens" narrative — were
both the least-attended by the model and the most hallucination-prone. Declarative
sections were more reliable.

Map that onto your schema. `reproduction` is machine-captured — safe, already correct
by design. `why` is free-text, model-authored, procedural, and currently checked by
nothing. `policyViolations()` validates that a verdict agrees with an exit code; it
never checks that `why`'s claimed mechanism is consistent with the `stack` and `covered`
evidence already sitting in the same case file.

Add a cheap consistency check at the `write_case.mjs` boundary: does `why` reference a
file:line that appears in `stack` or `covered`? Does it name a function that's actually
in scope? This is pattern-matching, not semantic understanding — it will not catch a
plausible-but-wrong causal story, only a causal story that isn't even talking about the
evidence in front of it. Cheap, mechanical, and it closes the one schema field the
literature specifically flags as the highest-hallucination-risk shape of content you're
already storing.

### Everything else in v2 (E1 bisect, E3 spectrum, E4 shrink-parked, the deletions, the

14-day order) stands unchanged. This document adds to it; it does not replace it.

---

## 2. How you confirm this thing works — three tiers, do not conflate them

This is the part you're actually asking, so be precise about it, because the easy
mistake is declaring victory on the cheap tier and never running the expensive one.

### Tier 0 — mechanical self-test (you already mostly have this)

`npm test`, the guards, the schema validation, the refusal tests. This proves the
_software_ does what it claims to do at the code level: a misspelled field is rejected,
`--control` gates correctly, ids can't escape the store directory. **This tells you
nothing about whether the tool finds correct causes.** It cannot — it's a regression
net written by the thing it tests, and §11 of `architecture.md` already documents that
this exact class of test suite missed every real defect the tool has ever caught in the
wild (5 defects, 0 caught by the self-authored corpus). Keep running it. Never cite it
as evidence the product works.

### Tier 1 — a mutation-seeded canary, build this week, run nightly

You don't have to wait for a curated bug corpus to get a continuous signal. Mutation
testing gives you an infinite supply of synthetic bugs with **exact, unambiguous ground
truth**: mutate a line (invert a conditional, flip a comparison, drop a null check),
and the mutated line _is_ the root cause, by construction, the moment a test starts
failing.

```
evals/canary.mjs:
  1. Run mutation testing (mutmut for Python targets, a small custom AST mutator
     for JS/TS — Stryker's mutant-generation logic is a fine model to copy) against
     a handful of real repos you already have on disk (this repo, floorplanner, vitruva).
  2. For each mutant that a test catches ("killed"), you now have a (file, line,
     failing command) triple with known ground truth.
  3. Feed reproduce.mjs the failing command, let the spine run to a verdict.
  4. Score: did candidates[0].location match the mutated line? Did the probe flip
     correctly? Did an "equivalent mutant" (killed by nothing) correctly produce
     zero candidates rather than a hallucinated one?
  5. Emit one row per mutant to a JSONL log. Run this in CI, nightly or per-PR.
```

**Say the limit out loud, because it's real and well known in the mutation-testing
literature:** mutants are a systematically easier and differently-shaped target than
real faults. A single-token AST mutation is not a missing null check written by a human
under deadline pressure, and tools have been shown to over-fit to mutant-shaped bugs
before. Treat Tier 1 as: (a) a regression alarm — if cause-hit@1 on the canary drops
between Tuesday and Wednesday, something in ranking broke, and you find out same-day
instead of at the next benchmark run six weeks later; (b) a cheap way to catch gross
breakage in the probe and the blind checker before they ever see a real bug. **Do not
report canary numbers as evidence the product works on real bugs.** That claim requires
Tier 2, and only Tier 2.

### Tier 2 — the paired benchmark, unchanged from v2, now with two more columns

Same corpus plan as v2: ~200 instances from BugsInPy (reproducibility caveat noted
there — expect real-world attrition, budget triage time), HaPy-Bug's line-level
annotations to keep grading honest, SWE-bench Verified as a secondary check, a small
freshly-mined GitBug-Actions slice as the one arm immune to memorization. Same arms
(bare agent vs. agent+ducktective, same model, same budget). Same primary metric —
**C2, false-confirm rate**: did the tool assert a specific cause that misses every gold
hunk. Add two columns this round:

| id     | metric                                  | what it isolates                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C8** | blind-checker overturn rate             | of verdicts that would have shipped `confirmed` under v2's same-process probe, what fraction does the E5 blind re-derivation downgrade? If this is near zero, the blind separation bought nothing over the cheaper same-process version — cut E2's added cost and say so. If it's material (the AnyPoC numbers suggest it will be), that's your strongest single number: it is the exact, direct, quantified size of the reward-hacking problem this pitch exists to solve. |
| **C9** | why/evidence consistency violation rate | how often does E5's cheap pattern-match catch a `why` field that isn't even talking about the evidence in its own case file? A non-trivial rate here is direct confirmation of the hallucination paper's finding applied to your own schema, not a borrowed statistic.                                                                                                                                                                                                      |

### The rule that ties the tiers together

Tier 0 failing means the software is broken — fix it, it says nothing about the product.
Tier 1 failing means something regressed since last week — fix it, it still says
nothing about the product beyond "didn't get worse." **Only Tier 2, run to completion,
against a corpus you didn't author, answers "does this tool work."** Everything in this
document that looks like progress before Tier 2 completes — the canary going green, the
guards passing, a clean CI run — is necessary and proves nothing. Say this to yourself
before you're tempted to ship on the strength of a green canary; the whole point of §16's
original verdict was that a green suite has already once told you the tool was fine when
it wasn't.

---

## 3. Why you might still be fooling yourself even after building all of this

Be honest about the residual risk, because the fixes above are not a free lunch and the
source material says so directly.

- **The blind checker isn't zero either.** Even with full structural separation, the
  best-performing configuration in the one paper that measured it still produced some
  invalid outputs, not none, and cost roughly 2–4× more than the naive version for the
  privilege. If your C8 overturn rate comes back near-total — the blind checker
  disagrees with almost everything — that's not success, that's evidence your candidate
  generation is producing garbage upstream and the checker is just the first thing
  honest enough to say so.
- **A canary that's all green tells you the mutants are easy, not that the tool is
  good.** If Tier 1 numbers look great and Tier 2 numbers don't, trust Tier 2. That gap
  is itself informative — it's telling you exactly how mutant-shaped your candidate
  ranking has become.
- **Retrieval and indexing help — but only up to the depth you fund.** The paper that
  showed retrieval-guided detection nearly doubling precision also showed it still
  capped exploration depth for cost reasons, and missed cases specifically at the
  boundary of that cap. E1/E3 will have the same shape of failure. Don't be surprised
  when the eventual error analysis says "ran out of budget one hop short of the real
  cause" — budget it for from day one rather than treating it as a bug when it shows up.

---

## 4. Delete / build order (updated)

Everything in v2's delete list and 14-day schedule stands. Insert two items:

| Day                              | Add                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4–5 (with the probe)             | Build E5's consistency check in the same commit as E2 — it's a few hours of regex/AST work against fields you already schema-validate, and it's free once `write_case.mjs`'s validation boundary is open for the probe work anyway.   |
| 6 (before the benchmark harness) | Stand up `evals/canary.mjs` against this repo's own test suite first — cheapest possible mutant source, zero new infra — before pointing it at floorplanner or vitruva. Get one nightly CI run green before touching BugsInPy triage. |

---

## 5. What would make this wrong

Same four conditions from v2, plus:

5. **If C8 (blind-checker overturn rate) is near zero across the whole benchmark**, the
   reward-hacking problem this document treats as central turns out not to be your
   problem — maybe your existing `--control` gate already screens most of it out in
   practice, even though it isn't designed to. That would be a genuinely interesting,
   genuinely good result. It would also mean E2's added cost isn't earning its keep, and
   the honest move is to cut it back down to v2's cheaper same-process version and spend
   the saved budget on E1/E3 instead.
