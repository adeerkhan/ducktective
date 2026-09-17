# Ducktective — design.md (v2, the redirection)

Written 2026-09-15 against `architecture.md` @ `31bc9f7`. This document disagrees with
the current plan. Where it disagrees, it says what evidence would make it wrong.

---

## 0. One-paragraph summary

You built a **protocol** and are trying to prove it with a **field study**. Both choices
are wrong, and they are wrong for the same reason: they require a human to keep
following rules. §16 already recorded the fatal datum and filed it as a footnote —
_the author skipped the bare-baseline rule twice in one day while doing nothing else._
That is not a discipline problem. That is the product failing its first user. The fix is
to stop requiring the protocol and start selling the **verdict**: a single terminal
command that grades a root-cause claim an agent already made, using evidence the agent
did not bother to collect. And to stop deciding the project on 10–15 hand-graded bugs,
which cannot reach significance, and decide it on ~200 benchmark bugs with mechanical
ground truth, which you can run overnight.

---

## 1. Five diagnoses

### D1 — The discovery half was dead at design time, not empirically

§16 treats "discovery value: none demonstrated" as a finding. It was a theorem.

Look at what feeds `seedCandidates`: parsed traceback frames, plus a fail-only coverage
diff. Both are already in the host agent's context — it ran the command, it read the
traceback. **There is no information in the system that the model did not already have.**
A protocol that reorders known information cannot find something a careful engineer with
a terminal would miss. You spent a month discovering that empirically, on n=2.

It's worse than that. The published numbers say file-level localization is close to
saturated: a 2025 trajectory study found agents modified the correct file in
<cite index="9-1">93–96% of successful trajectories and still 59–81% of _failed_ ones</cite>,
and dedicated localizers report <cite index="2-1">roughly 81% recall@1 on SWE-bench Verified</cite>.
Candidate ranking by traceback order is competing in a solved category. The same study
shows the gap: <cite index="9-1">function-level match drops to about 27–33% even on successes</cite>.
**Finding the file is free. Being right about the cause is not.** Everything you build
from here should aim at the second number.

### D2 — Your oracle proves _agreement_, not _discrimination_

This is the most serious technical hole and it's one line of arithmetic away from fixed.

`classify()` says `confirmed` when `(predicted === "pass") === (exit === 0)`, after
`--control` passes. `--control` proves the check is **not always-fail**. Nothing proves
the check is **not always-pass**, and nothing proves the check's outcome depends on the
accused line at all.

So the model can write a check that touches nothing, predict "pass," get exit 0, and the
store will accept `confirmed` with full provenance. That isn't hypothetical — §7 records
exactly this class: a check ran under the wrong interpreter, died on
`ModuleNotFoundError`, _and the arithmetic filed the hypothesis as falsified_. You fixed
the interpreter. You did not fix the fact that **the arithmetic cannot tell a check that
tested something from a check that tested nothing.**

A verdict that is unfalsifiable-by-construction in a tool whose entire pitch is
falsification is a branding emergency, not a bug.

### D3 — Your decision procedure cannot decide

§9 wants 3 paired bugs by 2026-09-29. Suppose you get them and the protocol wins 3–0.
Under the null that both arms are equal, that outcome has probability 1/8. You cannot
reject anything. At 10 bugs with a 7–3 split you still can't. To detect a ~15-point
swing in "was the root cause right" with the usual power you need discordant pairs on
the order of **100**, not 3.

And every input is human: a human finds the bug, a human remembers to run the bare
baseline _first_, a human judges afterwards whether the accused line was really the
cause. §14 concedes it — _"the project's headline number is the least mechanical one in
the ledger."_ You wrote a rule (invariant 10: no claim without a receipt) and then
designed the one measurement that can only ever produce a receipt signed by yourself.

### D4 — Capital is in the wrong layer

Count the maintenance surface serving zero external users: a Vite/React SPA with five
routes, a browser demo engine with its own view model, a schema↔site sync guard, a
plugin marketplace manifest pinned by a test, three installer targets, a 643-line
architecture doc, and a CI guard that fails when that doc goes stale. Against four
zero-dependency scripts that do the actual work.

You have built a **documentation apparatus for a measurement apparatus for a claim you
have not tested.** The guards are excellent. They are also the most sophisticated
displacement activity I have read this year: writing "this is unproven" very precisely
feels like progress, and it is not progress.

### D5 — Memory is unevaluable by construction, and you know it

M5 needs a populated store. The store fills from investigations. Investigations have no
demonstrated value. So M5 cannot be measured until the thing it's meant to improve is
already working. `query_memory.mjs`, the rap-sheet overlap ranking, the site's `/cases`
route, and one whole metric slot are all financed by a feature that cannot be assessed
this year. Park it properly — delete the route, keep the JSONL.

### D6 (bonus, and I'd fix it today) — you shipped a confident wrong cause in §16

> _`docs/` was **re-appended to `.gitignore` by something outside the repo** (no git hooks exist here)_

That is an unfalsified causal claim about an unobserved agent, asserted in bold, in the
closing section of a document arguing that unfalsified causal claims must be refused.
Rule 2 would have refused it. Go find the actual writer: `git log -p -- .gitignore`,
shell history, `core.excludesFile`, any agent/CLI/scaffolder that ran in that directory,
editor plugins. It is almost certainly a tool you invoked. Until you find it, the
project's reference document contains the exact defect the project exists to prevent.

---

## 2. The reframe

**From:** a protocol the host agent must be persuaded to follow.
**To:** an evidence engine that does mechanical work the agent won't do, exposed as a
single command that grades a claim the agent already made.

The pivot is forced by your own finding. If the ceiling is adoption cost — and §16 says
it is, on evidence from the author — then the correct move is to drive adoption cost to
approximately zero. A protocol has high adoption cost by definition: it must be followed
in order, under pressure, when you're in a hurry. A checker has near-zero adoption cost:
you call it once, at the end, on something you already believe.

```
$ ducktective check --claim "candidate.py:411 returns None when cache is cold" \
                    --repro "pytest tests/test_cache.py::test_cold -x"

  reproduces        ✓  exit 1, 3 in-repo frames
  regression        ✓  first bad commit a91f30c  "cache: short-circuit empty keys"  (8 steps)
  claim ∈ commit    ✓  a91f30c touches candidate.py:404-418
  check discriminates ✓ neutering :411 flips the check (probe)
  control           ✓  passes on HEAD~1
  prediction        ✓  predicted fail, exit 1
  survives re-run   ✓
  ─────────────────────────────────────────────
  GRADE: A   (6/6 earned, 0 asserted)   case DT-260915-c31aa9
```

Everything in that box is already built or is a weekend away. Nothing in it requires
anyone to change how they debug. The case file stops being a compliance artifact and
becomes the thing people actually want: **a receipt they can paste into a PR.**

Keep the name. Change the tagline. It is not "a detective." It is **receipts for root
causes.**

---

## 3. Build these four things, in this order

### E1 — `bisect.mjs` (highest expected value in the whole project)

`git bisect run` is the strongest automatic root-cause tool ever built, it is sitting on
every user's machine, and **it does not appear anywhere in your architecture.** For any
regression with a reproducing command it returns a commit — a fact, not an opinion,
obtained in O(log n) runs.

```
git bisect start <bad> <good>
git bisect run sh -c '<repro cmd>'      # 0 = good, 125 = skip, 1..127 = bad
```

- **Good ref discovery:** walk back tags, then commits, doubling (HEAD~8, ~16, ~32…)
  until the repro passes; cap the walk and report `no-good-ref` honestly.
- **Cost gate:** measure the repro once, refuse above `--budget` seconds, print the
  estimate (`~11 runs × 4.2s ≈ 46s`) and require `--yes` like everything else.
- **Flakiness:** `--repeat N`; any disagreement ⇒ `inconclusive`, never a commit.
- **Env drift:** exit 125 on install/build failure ⇒ skip, and count skips in the case file.
- **Output:** `first_bad_commit`, its touched hunks, and the _intersection_ of those hunks
  with the model's claimed location. That intersection is a new, mechanical, high-signal
  fact — and it feeds candidate seeding as well as grading.

Honest limits, printed by the tool: regressions only (the test must have passed
sometime), needs a buildable history, worthless for a bug that was always there. Say so
in the output, not in a doc.

### E2 — the probe (`--probe`): the missing third control

Make `confirmed` mean something. Today: prediction matched, and the check isn't
always-fail. Add: **the check's outcome is causally sensitive to the accused location.**

Mechanically neuter the accused line and require the check result to flip:

| Accused construct | Probe                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------- |
| any statement     | inject `raise AssertionError("dt-probe")` / `throw new Error(...)` immediately before |
| a `return expr`   | replace with a sentinel return                                                        |
| a conditional     | invert it                                                                             |
| a constant        | perturb it                                                                            |

Run the check again. If the result **does not change**, the check does not depend on the
suspect and the verdict is `inconclusive_vacuous`, not `confirmed`. Applied on a scratch
worktree (`git worktree add`), never the user's tree; reverted always; refuses on a dirty
tree.

New lattice:

```
confirmed   ⇐ prediction matched ∧ control passes ∧ probe flips
inconclusive_vacuous ⇐ probe does not flip           (NEW — most confident wrong answers land here)
inconclusive ⇐ control fails ∨ timeout ∨ unrunnable
falsified   ⇐ prediction contradicted
```

This is the one place where you have a real, defensible, novel claim. Existing debug
tooling instruments and hypothesises; hypothesis-verification work in adjacent areas
verifies by <cite index="17-1">intervention rather than logs alone</cite>. Nobody in
the agent-skill space is refusing to write a verdict because the check didn't demonstrably
depend on the accused line. Lead with it.

### E3 — `spectrum.mjs` (Ochiai SBFL over the whole suite)

You already collect coverage.py JSON and then throw away almost all of its power with a
fail-only diff. Run the whole suite with per-test contexts (`pytest --cov-context=test`)
and rank by Ochiai:

```
susp(s) = e_f / sqrt( (e_f + n_f) * (e_f + e_p) )
```

`e_f` = failing tests covering `s`, `n_f` = failing tests not covering it, `e_p` = passing
tests covering it. This is an information source the agent genuinely does not have,
because no agent is going to run your full suite with context tracking on its own.

Be honest about strength: it's a **prior for ranking**, never a verdict. Coverage is a
poor proxy for fault relevance — one recent comparison found nearly
<cite index="24-1">identical line and branch coverage between test sets with wildly different fault-detection rates</cite>.
So: gate behind `--spectrum`, print the cost, merge into `seedCandidates` as one signal
among frames and bisect hunks, and measure whether it moves cause-hit@1 on the benchmark
(§4). If it doesn't, delete it — that's what the benchmark is for.

### E4 — `shrink.mjs` (ddmin)

Delta-debugging a failing input to a minimal reproducer. Real value when the repro has an
input surface (a payload, a file, a parametrized case); no value for a plain failing unit
test. **Park it** behind the benchmark: build it only if §4 shows a meaningful slice of
instances where the repro carries an input.

### Explicitly still not building

Graph expansion, cold scan, metamorphic/oracle-free checks, multi-agent roles, embeddings,
SQLite. §13's triggers stand. Note that E1+E3 are the honest replacement for what the
graph was _for_ (information the model lacks) at a fraction of the cost.

---

## 4. Measurement: benchmark first, field study maybe never

Replace §8.2's 10–15 hand-graded bugs with a replayable harness. Not because field
evidence is bad, but because field evidence at n=3 with a self-grading author is not
evidence, and because **you cannot tune a protocol on 2 samples** — every design choice
above (does SBFL help? does bisect intersection help? does the probe cost more than it
saves?) is unanswerable without a corpus you can re-run.

### Corpus

| Source                 | Why                                                                                                                                                                                    | Caveat                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **BugsInPy**           | <cite index="23-1">493 real bugs across 17 Python projects, each with a failing test and a human ground-truth patch</cite>; Docker-based checkout/test/coverage harness already exists | <cite index="23-1">reproducibility decays — one audit three years on found only ~67% of expected results</cite>; budget time for triage |
| **HaPy-Bug**           | <cite index="27-1">human line-level annotations over BugsInPy separating bug-fix lines from refactoring, docs and tests</cite>                                                         | smaller; use it to _clean_ the gold set                                                                                                 |
| **SWE-bench Verified** | <cite index="6-1">500 human-validated instances from 12 Python repos, with established harnesses</cite>                                                                                | contamination is a live concern in 2026 — use as a secondary, report separately                                                         |
| **fresh mined slice**  | <cite index="22-1">GitBug-Actions mines bug-fix pairs from GitHub Actions runs and exports a Docker image per bug</cite>                                                               | the only arm immune to memorization; ~30 instances is enough to sanity-check the others                                                 |

Pick **~200 reproducible instances** total. Keep a held-out third you don't look at until
the end.

### Task definition (narrow on purpose)

Given the repo at the buggy commit and the failing test command, output a **root-cause
location (file + line span) and a one-line cause.** Not a patch. You are not competing
with automated program repair; you are competing with _confidently wrong explanations_,
which nobody else is measuring.

### Arms — paired by construction, no human memory involved

- **A (bare):** host agent, same model, same budget, no skill.
- **B (protocol):** host agent + ducktective.
- Both on identical containers, both fresh, run in either order — the contamination
  problem M9 was built to dodge disappears, because neither arm is a person.

### Metrics — all mechanical

| id     | metric                 | definition                                                                              |
| ------ | ---------------------- | --------------------------------------------------------------------------------------- |
| **C1** | cause-hit@1 (hunk)     | claimed span intersects a gold bug-fix hunk (HaPy-annotated lines only)                 |
| **C2** | **false-confirm rate** | emitted a `confirmed`/high-confidence cause that misses every gold hunk                 |
| **C3** | abstention rate        | stopped or declared inconclusive rather than asserting                                  |
| **C4** | token cost             | from the API response, per instance, per arm                                            |
| **C5** | wall clock             | harness-measured                                                                        |
| **C6** | bisect yield           | fraction where E1 returned a commit; of those, fraction whose hunks contain a gold hunk |
| **C7** | probe kill rate        | fraction of otherwise-`confirmed` verdicts demoted to `inconclusive_vacuous`            |

**C2 is the product.** The sentence you want to be able to say is: _"the bare agent
asserts a wrong root cause in X% of cases; with ducktective it asserts a wrong root cause
in Y%, at Z% more tokens."_ That sentence is worth a company. "It enforces discipline" is
worth a blog post.

C7 is your novelty receipt: it directly counts wrong confident answers that only this
tool caught, with no human in the loop.

Do **not** report file-level accuracy. It's saturated (D1); reporting it makes you look
like you don't know the field.

### Decision rule (replaces §9)

Run the 200. Then:

- **C2 drops by ≥10 points absolute, at ≤2× tokens** → you have a product. Ship, publish
  the table, go find users.
- **C2 drops <5 points, or cost >3×** → the protocol does not pay. Archive the protocol;
  **keep `bisect.mjs` + the probe as a standalone `ducktective check`**, which stands on
  its own merits regardless.
- **C7 ≈ 0** → the probe finds nothing, which means the checks models write are already
  discriminating, which means D2 was wrong and I owe you an apology. Delete the probe.

Date it and put it in the README.

---

## 5. Delete this week

| Delete / freeze                                                                                              | Why                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `/workbench`, `/cases`, `/protocol` routes + the demo engine + `case-import.mjs` + `site-case-sync.test.mjs` | a marketing simulation of an unvalidated claim, with its own untested engine (§14 admits it) |
| the plugin marketplace manifests + their guard                                                               | <cite index="6-1">unexercised</cite> distribution for a product with no demand signal        |
| two of three installer targets                                                                               | keep `--dest`; add targets when someone asks                                                 |
| `query_memory.mjs` from the spine                                                                            | keep the JSONL, park the feature (D5)                                                        |
| `architecture.md` → regenerate at ~150 lines after the pivot                                                 | reference rot is not the problem when the reference is 4× the code                           |
| the M1–M9 ledger's hand-transcribed columns                                                                  | §4 makes them mechanical or irrelevant                                                       |

Keep the site to exactly one page: what it does, the C1/C2 table once you have it, and
`/skill`. Ship the honest numbers or ship nothing.

---

## 6. Fourteen days

| Day   | Do                                                                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Find the real `.gitignore` writer (D6). Delete §5's row when you have the answer.                                                                                 |
| 1     | Delete everything in §5. Repo should lose ≥40% of its files and 100% of its npm site deps.                                                                        |
| 2–3   | `bisect.mjs`: good-ref walk, budget gate, `--repeat`, 125-skip, hunk intersection. Tests on a synthetic 40-commit repo with a known bad commit.                   |
| 4–5   | The probe: scratch worktree, four neuter strategies, `inconclusive_vacuous`, schema + `policyViolations()` + refusal tests.                                       |
| 6–8   | Benchmark harness: BugsInPy triage → ~150 reproducible instances, HaPy gold-set cleaning, arm A and arm B runners, C1–C7 emitted as JSONL.                        |
| 9     | First full run, arm A only. This is your baseline, obtained without asking a human to remember anything.                                                          |
| 10    | First full run, arm B.                                                                                                                                            |
| 11    | Read the table. Apply §4's decision rule. Write the result down **before** deciding how you feel about it.                                                        |
| 12–13 | `spectrum.mjs` only if C1 in arm B is materially below the field's ~81% recall@1 — i.e. only if ranking is actually your bottleneck.                              |
| 14    | Publish: one page, one table, the corpus list, the harness. A reproducible table from a stranger's corpus is worth more than 15 field cases from your own laptop. |

Note what is absent: no new docs, no site work, no packaging, no users-to-find-first.
Users come after C2.

---

## 7. What would make me wrong

State these now so you can hold me to them:

1. **If C7 ≈ 0**, D2 was overblown — the discrimination hole is theoretical and the
   existing control is sufficient.
2. **If bisect yield (C6) < 20%**, most real bugs in the corpus aren't regressions and E1
   is a niche feature, not the spine.
3. **If arm A's C2 is already low** (agents rarely assert wrong causes when a failing test
   is present), the entire premise of the project is false and the correct action is to
   archive with a good receipt — which, to be clear, would be a _successful_ outcome for
   a research project and a much better use of six weeks than polishing a site.
4. **If the corpus is too contaminated to trust** (arm A does suspiciously well on
   SWE-bench and badly on the freshly-mined slice), the benchmark plan is compromised and
   the field study comes back — but with the mechanical probe/bisect receipts making the
   human grading much cheaper.

---

## 8. The one-line version

Stop making people follow a protocol; start handing them receipts. Get the receipts from
`git bisect` and a mutation probe, not from prose discipline. Decide the project on 200
benchmark bugs with mechanical ground truth, not on 3 bugs you graded yourself. And go
find whatever edited your `.gitignore` — right now, that is the only confirmed bug in this
repository that nobody has localised.
