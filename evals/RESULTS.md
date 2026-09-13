# Week-1 stress run — what the gate actually did

Run: 2026-09-12, on this machine (`node v24.20.0`, `python 3.14.7`, `pytest 9.1.1`,
`coverage.py 7.16.0` in `.venv-eval/`). Reproduce with:

```bash
npm run eval            # all 12 cases
npm run eval -- pytest  # one subset
```

Cases live in `evals/cases/`, one directory each, with a `case.json` naming a real
command and what the gate must conclude. `evals/run.mjs` runs `reproduce.mjs`
against each with the case directory as cwd.

**These are constructed fixtures, not the doc's "10–15 real bugs in your repos".**
They are real executions of real failing code — pytest, unittest, plain scripts,
`node --test`, coverage.py — but they were written to cover classifier
boundaries, not sampled from a backlog. Days 11–12 of the plan still need your own
repositories. What this run _does_ buy is that a bug found here is a bug in the
gate, not in someone's project.

## Results

| Metric                                                    | Result           | Note                                                                  |
| --------------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| Stale tickets stopped before any investigation            | **2/2 (100%)**   | the doc's first metric, "must be near 100%"                           |
| Broken commands refused rather than called a reproduction | **4/4 (100%)**   | `error` exit 2; a typo'd path is not a bug found                      |
| Nearest-fault ranking — throw site above its caller       | **6/6 (100%)**   | pytest, unittest, plain script, `node --test`, module throw, coverage |
| Cases behaving exactly as specified                       | **12/12 (100%)** |                                                                       |

The stop metric is split in two because the doc asks specifically about _non-reproducing symptoms_; merged, four broken-command refusals would carry a metric that needs two stale tickets.

Reproduced (6): `pytest-offbyone`, `unittest-lib`, `script-plain`, `node-test-fail`,
`node-module-throw`, `coverage-failonly`.
Stopped (2): `pytest-stale`, `python-green-script` → `does_not_reproduce`, zero candidates.
Refused to investigate (4): `pytest-missing-file`, `pytest-empty-suite`,
`unittest-typo-module`, `node-missing-file` → `error`, zero candidates.

## What this run caught (all now fixed, all still covered by tests)

1. **pytest was never parseable.** pytest doesn't print `File "…", line N, in fn`
   for a failed assert; it prints `test_money.py:5: AssertionError`. The parser
   matched zero frames, and a genuine reproduction was classified `error` — the
   doc's headline target (pytest first) was broken end to end and no unit test saw
   it, because the fixtures used unittest. Now `LOC_FRAME` parses both, and
   `nearest fault` is asserted against the tool's own normalized location.
2. **An empty regex alternative.** `RUNNER_MISUSE` ended in `interrupted: |`, so the
   alternation matched the empty string — `test()` was true for _every_ run,
   `node-missing-file` passed for the wrong reason, and the dependency-only branch
   was unreachable. The case that "passed" hid it until each alternative was
   asserted individually, positive and negative.
3. **`node --test` detected from V8 frames.** A plain `node main.mjs` crash prints
   frames too, so every plain JS run was labelled `node-test`. Detection is now
   command-based, then TAP/reporter markers.
4. **coverage.py accumulates.** Both phases shared one `.coverage` data file, so the
   "failing" and "baseline" line sets were identical and the fail-only diff was
   empty. Each phase now starts from a clean data file, and the real signal shows
   up: `cart.py:7` — the branch only the failing test reaches.

## Found by re-reading the design doc, not by the corpus

The corpus measures the gate; it cannot tell you whether the gate is the one the
plan asked for. Two gaps and one broken render surfaced from the doc itself:

- **`Confirmed → stop` was unenforced** (Core Design step 3). `blockers()` only
  looked backwards for unfinished leads, so after a confirmed cause the tool
  happily tested on — escalation prevented, continuation not. Now a `confirmed`
  candidate blocks the next one, same as an `inconclusive` one, with `--escalate`
  as the deliberate override and `--depth 1` forbidding escalation outright
  (which is why the candidate cap is called `--max-candidates`, not `--depth`).
- **The doc rendered as two grey slabs.** Line 1 was a `​```markdown` fence pasted
  out of a chat and line 182 closed it, so Purpose-through-metrics showed as
  one code block. Deleted; the only fence left is the spine block.
- **The README documented an install path Codex does not scan** (`~/.codex/skills`
  instead of `~/.agents/skills`) because a silent string replacement missed it
  after formatting reflowed the table. `scripts/plugin-manifests.test.mjs` now
  fails if README and `install.mjs` disagree about a target — prose drift needs a
  test like any other claim.

## The first real-repo pilot (and the two bugs it found)

`evals/runlog.mjs` keeps a per-case ledger; `evals/RUNLOG.csv` holds the rows, with
a `provenance` column because `docs/ref-work.md` §8 says to "measure on repos you
don't control the selection of, and say so". Pilot against
`ref/scientific-agent-skills` — a third-party repo, its own test tree, nothing about
the case chosen by me:

| Command                                                                   | Truth                 | Gate said                                 | Correct?  |
| ------------------------------------------------------------------------- | --------------------- | ----------------------------------------- | --------- |
| `pytest -q tests` (repo refuses: 105 skills share module names)           | broken invocation     | first run: **`reproduced`**, 0 candidates | ✗ **bug** |
| `pytest -q tests/_contract` (no tests there)                              | nothing collected     | `error`                                   | ✓         |
| `pytest -q tests/analytical-method-validation/test_scripts.py` (112 pass) | symptom did not occur | `does_not_reproduce`                      | ✓         |

Two real bugs, neither reachable from my own fixtures:

1. **Evidence-free failures were called reproductions.** The classifier decided by
   matching error _strings_; this repo's message (`ERROR: cannot collect 105 skills
in one process …`) matched none of them, so a usage error exited as a
   reproduced symptom. Now the rule is evidence, not vocabulary: non-zero exit with
   no in-repo traceback frame and no fail-only coverage line is `error`. That also
   deleted the old `RUNNER_MISUSE` branch as a _decision_ — it now only chooses the
   wording of the note.
2. **`[eval]` counted as a repo file.** After fix 1, a new corpus case
   (`node -e "require('node:nothing_here')"`) still came back `reproduced`, because
   a pseudo-location has no separator and no drive, so "not absolute" read as
   local. `isLocalFile()` now rejects `<...>` / `[...]` shapes; `python -c`'s
   `<string>` was the same hole waiting to be hit.

Both are pinned: `node-external-only` and `pytest-bad-flag` are corpus cases (14 now), `isLocalFile` has a unit test, and the run log has its own tests — because the
first version of the ledger parsed rows with `line[i]` (characters, not fields),
reported "0 real cases" against real rows, and never raised. A measuring tool that
silently misreads is the worst kind of bug in a project whose whole pitch is
measurement.

Stop-correctness on the pilot: **3/3** with the fixes, and `no data` on the four
metrics that need a host model and a human — which is the honest state, not a gap
to fill in.

## Verified against real coverage.py, for the first time

`coverage-failonly` produces `cov-baseline.json` (passing test) and
`cov-failing.json` (failing test), and the gate reports fail-only sites
`cart.py:7`, `test_ship_bad.py:1,3,6,8` with the merged lead
`in the failing traceback and covered by the failing run only`. Before this run
that ingest path had only ever seen hand-written JSON.

## Not measured

- **Tokens per investigation vs a plain "fix this" prompt** — needs a host agent
  driving the skill, not a harness.
- **Whether a human prefers the case file** — needs a human. The artifact format is
  settled (`skills/ducktective/case-file.schema.json`, 30-second Markdown); the
  preference data is not.
- **First-falsification hit rate** — the mechanical half is in place (`run_check.mjs`
  records `predicted` + `check_exit_code`, and `write_case.mjs` refuses a verdict
  that contradicts either), but the number needs a model proposing the hypotheses.

Both of the first two are Days 11–12 of the plan and are yours to run; `npm run eval`
is the part that can be automated, and it is in CI's lane if you want it wired into
`deploy-site.yml`.
