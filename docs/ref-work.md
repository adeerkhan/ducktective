# Ducktective — Reference & Critical Landscape Review

_A companion document to `ducktective-design.md`. Purpose: find every serious
prior-art project in this space, take their claims apart, and figure out
honestly whether Ducktective's design is actually differentiated or just
reinventing something that already shipped (or already failed)._

---

## 0. How to Read This Document

For every project below you get four things: what it actually does, what it
actually proved (not what its marketing page says), how trustworthy that
proof is, and what it means for Ducktective. Section 7 is the payoff — the
part that argues for what would make Ducktective genuinely different rather
than a differently-themed version of something that already exists.

---

## 1. Executive Verdict

Be blunt about this up front: **the "graph + LLM + persistent memory"
shape is not a novel idea — it is where the entire field has already
converged.** Academic systems (LocAgent, AutoCodeRover), a commercial
acquisition target turned #1 leaderboard system (Sonar Foundation Agent),
and a proprietary startup pitch (Kodezi Chronos) all independently arrived
at "parse the repo into a graph, do multi-hop retrieval instead of
grep+read, keep some form of memory across attempts." If Ducktective's pitch
is "an agent that uses a code graph and remembers past bugs," that pitch is
three years old and has a leaderboard.

That is not a reason to abandon the project. It's a reason to stop treating
the graph-traversal loop itself as the differentiator and instead be
honest about what it actually is: **solid, well-validated infrastructure** —
and then go find the part of the problem nobody in this list is actually
solving. Section 7 argues that part exists and is genuinely available. But
it is not "graph traversal" or "chain of clues" in the abstract — those are
table stakes now, not a moat.

The second blunt point: **the field's own best controlled experiment
(Agentless) shows that adding agentic sophistication does not reliably
improve results, and can actively hurt cost and reliability.** Anyone
pitching "more detective-like reasoning steps" as inherently better needs to
answer Agentless's result, not ignore it.

---

## 2. The Landscape: Who's Actually Doing This

### 2.1 AutoCodeRover → SpecRover → Sonar Foundation Agent (the main lineage)

**AutoCodeRover** (NUS, ISSTA 2024) is the closest thing to "Ducktective,
already built, three years ago." It explicitly rejects treating a codebase
as a pile of files, works over the AST (classes/methods, not text blobs),
and — when a test suite exists — layers **spectrum-based fault localization
(SBFL)** on top: a decades-old statistical technique (Tarantula, Ochiai,
DStar) that ranks code by how disproportionately it's executed by _failing_
tests versus _passing_ ones. That is a rigorous, well-studied way to turn
"something is wrong" into "here is a ranked suspect list" — and it's exactly
the kind of cheap, non-LLM suspicion signal Ducktective's design already
leans on. Reported cost: ~$0.43/issue, ~22% resolved on SWE-bench Lite at
initial publication.

**SpecRover** (a.k.a. AutoCodeRover v2, ICSE 2025) adds something
Ducktective's first draft does _not_ have: **specification inference** — a
dedicated step where the agent states, in natural language, what a function
was _supposed_ to do before deciding whether it's guilty. That is the
detective concept of establishing motive/expected-behavior before
accusation, and the original Ducktective design skips straight to
suspicion-scoring without it. SpecRover also introduces reviewer and
self-correction agents that cross-check a patch against the original issue
text and reproducer test, and can diagnose _which_ upstream agent was wrong
and replay from there.

**Sonar Foundation Agent** (Sonar acquired AutoCodeRover in Feb 2025; the
resulting product topped the SWE-bench Verified leaderboard at 79.2% in
Feb/March 2026) is the part that should make you uncomfortable rather than
reassured: Sonar's own announcement describes the evolution from
AutoCodeRover to Foundation Agent as a move **away from a rigid, staged
pipeline toward a "free workflow" model**, leaning on a strong base model
(Claude Opus 4.5) with extended thinking and tool access rather than
hand-authored stage transitions. Their explicit claim is that once the
underlying model is good enough, prescriptive multi-step scaffolding
becomes a _liability_, not an asset.

**What this means for Ducktective:** the field's own trajectory is staged
pipeline → looser, model-driven reasoning as models get stronger. A rigid
five-step "detective loop" risks being exactly the kind of brittle
scaffolding the strongest current system deliberately moved away from.
Ducktective's loop needs an explicit escape hatch for cases where a strong
model is simply right on the first look — more on this in Section 6.

### 2.2 LocAgent — the actual "graph-guided detective," already published

If Ducktective is "a graph the agent walks to find bugs via multi-hop
reasoning," **LocAgent (ACL 2025)** is the paper version of that exact
sentence. It parses a codebase into a directed heterogeneous graph (files,
classes, functions; imports, calls, inheritance) specifically so an LLM
agent can do multi-hop reasoning instead of linear file reads. Its headline
result: a fine-tuned mid-size open model using the graph matches proprietary
SOTA localization accuracy at roughly **86% lower cost**, and better
localization measurably improves downstream issue-resolution (+12% pass@10).

**What this means for Ducktective:** the core empirical claim underpinning
Ducktective's whole pitch — "graph-guided multi-hop reasoning beats
grep+read on both cost and accuracy" — is not a hypothesis. It's a
published, peer-reviewed result. Good news (you're building on solid
ground); bad news (this specific claim cannot be your differentiator,
because it's already someone else's published contribution).

### 2.3 Agentless — the uncomfortable control group

**Agentless (FSE 2025)** exists specifically to test whether agentic
complexity is worth it. It does the boring thing — hierarchical
localization, then patch generation in plain diff format, then filter by
regression/reproduction tests, no autonomous tool-use loop at all — and it
_beat_ every open-source agent-based system on SWE-bench Lite at the time,
at a fraction of the cost (~$0.34/issue vs. $3+ for agent baselines).

**What this means for Ducktective:** this is the paper that should keep you
honest. Every extra "detective step" Ducktective adds needs to earn its
keep against the null hypothesis that a simpler pipeline does just as well
for less money. Don't add ceremony (interrogation transcripts, elaborate
hypothesis trees) because it's thematically satisfying — add it only where
you can point to what it catches that Agentless-style simplicity would miss.

### 2.4 CODER — multi-agent task graphs (and their actual cost)

**CODER (2024)** runs a five-role pipeline — manager, reproducer, fault
localizer, editor, verifier — coordinated via an explicit task graph, and
reuses AutoCodeRover's and SWE-agent's search/action primitives underneath.
It's real evidence that **role separation with a verifier as a distinct,
non-negotiable stage** is a workable pattern (Ducktective's design already
has an "alibi check" gate, which is the same idea under a different name).

**What this means for Ducktective:** the _reproducer_ role is worth stealing
outright — CODER treats "can we make the bug happen on demand" as a first-class
step before localization even starts, which the original Ducktective design
folds implicitly into "the symptom." Reproduction-first is a genuinely good,
underused idea to make explicit.

### 2.5 Kodezi Chronos — read the marketing, then read the fine print

**Kodezi Chronos** is worth studying closely for one reason: it's _almost
exactly_ Ducktective's pitch, dressed up as a product. "Adaptive Graph-Guided
Retrieval" (multi-hop traversal for navigating up to 10M lines), "Persistent
Debug Memory" (trained on 15M+ sessions, repo-specific learning claimed to
lift success from 35% to 65%), and a 7-layer "fix-test-refine" loop. Claimed
numbers: 65.3–67.3% autonomous fix accuracy, 80.33% on SWE-bench Lite
(which would beat Sonar's 79.2% on Verified, a harder benchmark — a
comparison Kodezi's own materials invite but don't actually make apples-to-apples).

Now the harsh part, because it matters: **every one of those numbers is
self-reported by Kodezi Inc., on Kodezi's own benchmark, with no independent
replication, and the model itself is still not publicly available** — first
promised for Q4 2025, then Q1 2026, and as of this document there is still
no public weights release, only a GitHub repo containing the benchmark
_harness_ (not the model). A company benchmarking its own unreleased model
against competitors on its own dataset, sixteen-plus months into "coming
very soon," is a pattern worth naming plainly: unverifiable marketing
claims, not evidence.

**What this means for Ducktective:** don't copy Chronos's architecture
because Chronos says it works — copy the _idea_ that persistent, cross-session
debug memory should meaningfully help (that's plausible and testable), but
build your own evidence for it rather than inheriting an unverified number.
And don't be tempted to market Ducktective the way Chronos markets itself.
If you can only produce three real before/after numbers on your own repos,
that's worth more than a self-reported 65.3%.

### 2.6 The "Agent Skills" ecosystem — shallow, not a graph system

Searching GitHub's actual Skills/plugin ecosystem (Anthropic's official
skills repo, community collections like `awesome-agent-skills`, and various
"root-cause-debugger" skills) turns up plenty of _debugging skills_ — but
essentially all of them are **prompt-only methodology checklists**:
"reproduce → isolate → hypothesize → test → fix," or "trace the call stack
backward via binary search." None of them ship an actual structural graph,
a persistent cross-session memory, or a suspicion-scoring mechanism. They're
instructions for how a model _should_ reason, not tooling that changes what
context the model actually sees.

**What this means for Ducktective:** there is a real, currently-empty seat
at this table — a debugging Skill that isn't just a checklist prompt but is
backed by an actual queryable graph (Graphify), actual retrieval (Semble),
and actual persistent memory (an MCP memory server). That gap is boring but
real: nobody has packaged the "serious agent" architecture (LocAgent/AutoCodeRover-class)
at the "Skill" layer of adoption (drop-in, no infra to stand up). That's a
legitimate distribution advantage even if the underlying technique isn't novel.

---

## 3. What's Already Solved — Don't Rebuild, Don't Claim As Novel

Be disciplined about this list. If Ducktective's pitch deck says any of
these are its innovation, that claim will not survive five minutes with
someone who's read the above.

| Already solved by                                                       | Do this instead in Ducktective                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Graph-guided multi-hop code localization beats grep+read (LocAgent)     | Cite it, use it, don't re-argue it                                                                          |
| AST-aware search + statistical fault localization (AutoCodeRover)       | Adopt SBFL wherever a test suite exists — it's free suspicion signal                                        |
| Specification inference before accusation (SpecRover)                   | Steal this outright — add a "stated motive" step                                                            |
| Reviewer / self-correction / replay-from-fault (SpecRover, CODER)       | Your "alibi check" gate should also diagnose _which_ stage was wrong, not just pass/fail                    |
| Reproduction-first workflow (CODER)                                     | Make "can we reproduce it on demand" an explicit, separate first step                                       |
| Persistent cross-session memory as a lever on accuracy (Kodezi's claim) | Plausible, worth building — but treat as a hypothesis to measure on your own repos, not an inherited number |
| Simple non-agentic pipelines can match or beat agentic ones (Agentless) | Every added step must justify itself against this null hypothesis                                           |

---

## 4. Where the Field Is Actually Weak

This is the part that took genuine digging, because it's not what any of
the above projects advertise about themselves — it's what's missing from
all of them simultaneously.

**4.1 — Every one of these systems assumes a symptom already exists.**
AutoCodeRover, SpecRover, LocAgent, Agentless, CODER, and Chronos are all
triggered by an already-known bad thing: a filed GitHub issue, a failing
test, a stack trace. Not one of them goes looking for trouble _before_
someone reports it. A real detective doesn't only work cases that walk in
the door — a good one also notices the unlocked window nobody mentioned.
Graphify's own `hidden_links` feature (semantically similar code that's
structurally disconnected — a classic signature of a duplicated function
whose twin got patched and this one didn't) is sitting right there,
unused for this purpose by anyone surveyed above.

**4.2 — Every benchmark in this space is a crash/exception/known-issue
benchmark.** SWE-bench and its variants are built from GitHub issues on
popular, mostly web/data-tooling Python repositories (Django, SymPy, scikit-learn,
requests). That is a specific, narrow bug shape: something throws, or a
test the maintainers already wrote fails. None of it targets **silent
correctness bugs** — code that runs to completion, throws nothing, and
produces a plausible but wrong numeric or geometric result. That is
precisely the bug class that dominates simulation, structural-analysis, and
geometry-solver code (i.e., exactly the domain of the user's own other
projects) — where there often _is no failing test_, because nobody wrote an
oracle for "is this stress value physically correct." There is real, if
niche, academic groundwork here (SBFL variants that work without a test
oracle, via metamorphic testing / metamorphic slices) — but it hasn't been
built into an agent by anyone surveyed above.

**4.3 — The deliverable everywhere is a patch, not a case.** Every system
above optimizes for "did the diff make the benchmark pass," and the
reasoning trace is a debugging artifact for the researchers, not a product
feature for the end user. For a bug in code where correctness actually
matters (structural or geometric calculations, not a typo in a Django
view), a silently-applied, benchmark-optimized patch is close to worthless
without an inspectable chain of evidence a human engineer can verify before
merging. Nobody surveyed here treats the evidence chain itself as a
first-class, structured output.

**4.4 — Persistent memory is claimed, not architected as a shared asset.**
Chronos claims a large lift from persistent memory but won't show its work.
Nobody in the open academic literature surveyed here has built a
memory layer that's queryable independently of the fixing pipeline — i.e.,
something a _human_ could ask "which functions in this repo have the worst
track record" before a new feature touches them. That's a preventative,
not just reactive, use of the same memory.

---

## 5. A Hard Critique of the Original `ducktective-design.md`

Turning the same scrutiny on the design doc this document is meant to
support:

- **No specification/motive step.** The design jumps from "rank suspects"
  to "interrogate," skipping the step SpecRover proved valuable: stating
  what the code _should_ do before asking whether it's guilty. Fix: add it
  (Section 6 below).
- **No explicit reproduction-first step.** "Symptom intake" quietly assumes
  the symptom is already reliably reproducible. CODER treats this as its
  own pipeline stage for a reason — reproduction failures are themselves
  informative (intermittent bug? environment-dependent? already fixed?).
- **The loop is rigid by construction**, at exactly the moment the field's
  current SOTA system (Sonar Foundation Agent) is explicitly moving toward
  looser, model-driven reasoning. The design needs an honestly-justified
  reason for its structure beyond "detectives follow steps" — the real
  justification is token efficiency and auditability for a _weaker or
  budget-constrained_ model, and it should say so, and should include a
  fast path for when a strong model is confident on the first pass.
- **No answer to Agentless.** The design doesn't explain why a multi-stage
  detective loop should be expected to beat a boring localize→repair→validate
  pipeline. It needs one, or it needs to concede the loop's value is
  interpretability and incremental token spend, not necessarily raw
  accuracy — a different, more honest pitch.
- **"Least tokens" is asserted, not architected against a real
  competitor's number.** LocAgent already reports an ~86% token/cost
  reduction using a graph. If Ducktective can't beat or match that number
  on a real repo, "least tokens" is not a claim, it's a hope.
- **The rap sheet / memory idea is good but under-specified relative to
  Kodezi's (unverified) claim of a 35%→65% lift.** The design should treat
  this explicitly as an experiment to run and measure, not an assumed win.

---

## 6. Concrete Revisions to Inject Into the Design

Mapped to the sections of `ducktective-design.md` as originally written:

1. **New step between §3.4 (Check the Priors) and §3.5 (Rank Suspects):
   Establish Motive.** For each candidate node, generate a one-line
   natural-language statement of intended behavior before scoring
   suspicion. A node that's doing exactly what it says it should do is a
   weaker suspect than one whose stated intent already looks inconsistent
   with the symptom — this is cheap (short generation) and catches
   contradictions before any expensive interrogation.

2. **New step before §3.1 (Crime Scene): Reproduce On Demand.** Before
   spending anything on localization, attempt to reproduce the symptom as
   a deterministic, re-runnable check. If reproduction fails, that's a
   result worth recording (flaky? environment-specific? stale report?) —
   don't silently assume the symptom is stable.

3. **§3.9 (Alibi Check) should diagnose, not just gate.** On failure, it
   shouldn't just demote the node — it should identify _which prior
   step_ (motive inference, ranking, expansion) produced the bad lead, so
   the search can replay from there instead of from scratch. This is
   SpecRover's self-correction idea, and it's a meaningfully better use of
   a failed check than a binary pass/fail.

4. **§7 (Single vs Multi-Agent): add an explicit fast-path / early-exit.**
   If the model's first-pass confidence on the top suspect is very high
   _and_ the alibi check confirms it immediately, skip the rest of the
   queue — don't force a full detective ceremony on an easy bug. This is
   the direct answer to the Sonar/Agentless critique: structure should be
   available, not mandatory.

5. **New mode: Cold Scan (addresses §4 in this document).** A separate,
   lower-priority background job that periodically walks Graphify's
   `hidden_links` and god-node/community-drift signals _without_ a
   triggering symptom, logging candidate "likely future bugs" to
   memory-server for review. This turns Ducktective from purely reactive
   to partially preventative — genuinely not something any surveyed system does.

6. **New mode: Oracle-Free Investigation (addresses §4.2).** When no
   failing test exists — the "silent bug" case — fall back to
   metamorphic/differential checks (does the same input under a known
   invariant transformation produce the expected corresponding output?)
   instead of SBFL, and say explicitly in the Reveal that confidence is
   lower because there was no test oracle to confirm against.

7. **Reveal output should be a structured "case file" object, not prose** —
   explicit fields for symptom, suspects considered and cleared (with
   reasons), the confirmed chain, and confidence — designed to be read and
   independently verified by a human engineer, not just a patch diff. This
   is the concrete version of "auditability" as a product feature rather
   than a nice-to-have.

8. **Track two honest metrics against real competitors, not just
   internally:** (a) tokens-per-investigation against LocAgent's reported
   ~86% reduction baseline, and (b) do NOT publish a Chronos-style
   self-reported headline number without independent replication — if you
   can't reproduce your own claim on a held-out repo, don't claim it.

---

## 7. The 10x Thesis — What Would Actually Make Ducktective Different

Stated plainly, because this is the part that matters:

Ducktective will not be 10x better than AutoCodeRover/LocAgent/Sonar at the
thing they already optimize for — crash-and-known-issue resolution on
popular open-source Python repos — because that is a crowded, well-funded,
leaderboard-driven race and none of the surveyed systems are amateur work.
Competing head-on there is a losing bet.

The genuinely open, defensible, and _honest_ differentiation is narrower
and more useful:

1. **Target silent/semantic bugs with no test oracle** — the bug class
   every surveyed system implicitly ignores — using differential/metamorphic
   checks instead of SBFL, aimed at numerical, geometric, and
   simulation-style codebases (not incidentally, the user's own domain).
2. **Make the evidence chain the product**, not a debug log behind a
   patch — a structured, human-auditable case file, for contexts where a
   silently-applied AI patch to correctness-critical code is not an
   acceptable deliverable on its own.
3. **Be preventative as well as reactive** via a background cold-scan over
   `hidden_links`/drift signals — nobody surveyed here does this.
4. **Be honest about persistent memory as an open experiment**, publishing
   your own before/after numbers on real repos instead of inheriting an
   unverified 35%→65% claim from a company that hasn't shipped its model.
5. **Package as a Skill, not just an agent** — the actual empty seat found
   in Section 2.6: a debugging Skill with LocAgent/AutoCodeRover-class
   machinery behind it, where every other debugging Skill on GitHub today
   is a bare prompt.

That combination — oracle-free bug classes, evidence-as-product,
preventative scanning, honestly-measured memory, Skill-level packaging — is
not claimed by any project surveyed above. It is also a much smaller, more
winnable fight than "beat Sonar's leaderboard score."

---

## 8. Risks and Honest Caveats

- Oracle-free / metamorphic bug detection is real but harder to make
  general than SBFL — it needs domain-specific invariants (what
  transformation of the input _should_ leave the output unchanged or
  change it predictably), which won't come for free per codebase.
- "Evidence chain as product" only matters to users who actually read it.
  If nobody on the team ever opens the case file, this differentiator is
  theoretical — validate that someone wants this before over-investing in it.
- The Skill-packaging advantage is a distribution moat, not a technical
  one — it disappears the moment someone else wraps Graphify+Semble+memory-server
  the same way. Move on it, don't assume it stays open.
- Don't let this document's criticism of Chronos read as "self-reported
  numbers are worthless" — it means _unreplicated_ self-reported numbers
  from a product that isn't shippable yet are worthless. Ducktective's own
  future benchmarks need to avoid the same trap: measure on repos you don't
  control the selection of, and say so.

---

## 9. Source Index

- AutoCodeRover — arXiv:2404.05427 (ISSTA 2024); github.com/nus-apr/auto-code-rover
- SpecRover — ICSE 2025 (abhikrc.com/pdf/ICSE25.pdf)
- Sonar Foundation Agent — sonarsource.com press releases, Feb/Mar 2026; github.com/AutoCodeRoverSG/sonar-foundation-agent
- LocAgent — arXiv:2503.09089 (ACL 2025); github.com/gersteinlab/LocAgent
- Agentless — arXiv:2407.01489 (FSE 2025); github.com/OpenAutoCoder/Agentless
- CODER — arXiv:2406.01304
- Kodezi Chronos — arXiv:2507.12482; github.com/Kodezi/Chronos; kodezi.com/blog/chronos-1
- Spectrum-based fault localization background — Tarantula (Jones & Harrold, ASE 2005), Ochiai/DStar surveys; "Spectrum-Based Fault Localization without Test Oracles" (metamorphic slices)
- Semble — github.com/MinishLab/semble
- Graphify — github.com/Graphify-Labs/graphify; graphify.com; graphify-mcp (github.com/yasinyaman/graphify-mcp)
- MCP knowledge-graph memory server — github.com/modelcontextprotocol/servers (server-memory)
- Agent Skills ecosystem — github.com/anthropics/skills; github.com/VoltAgent/awesome-agent-skills; agent-skills-hub.github.io
