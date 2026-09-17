# Ducktective — Architecture

**The single technical reference for this repository.** Distilled from
[`ducktective-design.md`](ducktective-design.md) (the plan) and
[`ref-work.md`](ref-work.md) (the landscape and the critique), and constrained to
what is **actually in the code**. Anything here that is a decision rather than a
fact says so; anything aspirational lives in the design doc, not here.

Verified against `b576d1d`+worktree on 16 Sep 2026, after the pivot in
[`ducktective-design.md`](ducktective-design.md) v2. Keep it true: when you change a
tool or a status, update this file — `scripts/skill-single-source.test.mjs` fails if
a shipped tool goes unmentioned here or in `SKILL.md`, which is the only realistic
defence against reference rot.

> **Status.** The instrument is built, green, and installed on a real box; the
> **product claim is untested and the discovery half of the pitch is already dead**
> (§16's verdict). Week 1 of the plan (gate, falsification, case file, store, memory)
> and most of week 2 (packaging, installer, manifests, README) exist. The open item is
> the one nobody can automate: 10–15 real bugs, each with a **bare baseline run first**
> (live counts: `node evals/runlog.mjs --report`).

---

## 1. Purpose

Ducktective exists because coding agents produce confident, plausible, **wrong**
root causes: they grep, read three files, declare victory, patch. It is the thin
protocol layer above whatever host agent you already run, and it does exactly
three things:

1. **Forces reproduction** before any localisation or reasoning is allowed.
2. **Finds the commit that broke it**, when it is a regression — the only step here
   that produces information the host agent did not already have.
3. **Forces an executable falsifying check** for every candidate hypothesis, runs
   it, and refuses to believe it unless the check demonstrably depends on the line
   being accused.
4. **Emits a permanent, structured case file** into a per-repo store, so a human can
   audit the investigation that just happened.

It is a **contract plus four small programs** — `reproduce`, `bisect`, `run_check`,
`write_case`. Not a runtime, not a daemon, not a
model, not a fixer. It never edits your code.

**Explicitly not** (design doc L137–144, upheld in code): no custom call graph or
`DuckGraph`, no multi-hop A\* suspicion scoring, no multi-agent detective roles,
no knowledge-graph server, no embeddings, no background scanning, no
oracle-free/metamorphic mode, no leaderboard or "industrial" claims.

---

## 2. System at a glance

```
   user: "investigate this failing test"
                      ┌────────────────────────────────────────────┐
                      │  HOST AGENT (Claude Code, Codex, Cursor…)  │
                      │  reads the contract, decides, writes the   │
                      │  hypothesis — never the verdict            │
                      └───────┬────────────────────────────────────┘
                              │ shells out, node, zero deps
   ┌──────────────────────────▼──────────────────────────────────────────────┐
   │ reproduce.mjs → bisect.mjs → run_check.mjs → write_case.mjs             │
   │   (gate)        (a commit,    (oracle +      (store +                   │
   │                  if it is a    probe)         enforcement)              │
   │                  regression)                                            │
   └───────────┬─────────────────────────────────────────────┬──────────────┘
               │ subprocess via the user's shell             │ append/update
        ┌──────▼───────────────────┐   ┌─────────────────────▼────────────────┐
        │ the user's test runner    │   │ <repo>/.ducktective/                │
        │ pytest · unittest · node  │   │   cases.jsonl  (machine, 1 per case)│
        │ · tsc · plain script      │   │   cases/<id>.md (human, 30 s)       │
        └───────────────────────────┘   └─────────────────────┬───────────────┘
                                                               │ read by a human
   ┌───────────────────────────────────────┐   ┌──────────────▼───────────────┐
   │ evals/ corpus + run log → metrics     │   │ SKILL.md, served by the      │
   │ scripts/ guards pin docs to code      │   │ installer, copied by hand    │
   └───────────────────────────────────────┘   └──────────────────────────────┘
```

There is **no server anywhere** and, since 16 Sep, **no website**: the skill is the
product, and a static SPA that re-implemented the spine in the browser to demo an
unvalidated claim was deleted (§9). `SKILL.md` is served as a file by the installer
and read as text by whoever wants it.

## 3. Repository anatomy

```
skills/ducktective/          THE PRODUCT — one folder, installable
  SKILL.md                   hard rules, tool commands, case-file template
  case-file.schema.json      the data contract (§6); JSON Schema subset
  scripts/                   the four tools (§4–§7); lib/ holds shared internals
  bin/install.mjs            clone install, one target + --dest
  tests/                     tool tests + a Python and a node:test fixture
docs/                        the plan (ducktective-design.md), the landscape
                             critique (ref-work.md), this file, and the external
                             critique that was answered (critique-2026-09-15.md)
evals/                       behaviour corpus, run log, results, runner
scripts/                     repo guards: single source, manifests, run-log
.github/workflows/           eval.yml (corpus on real pytest + coverage.py)
ref/                         gitignored research clones — never imported from
.ducktective/                gitignored: this repo is the workshop, not the patient
```

`skills/ducktective/SKILL.md` is the **only copy of the skill** in the repo, and the
installer ships `SKILL.md`, the schema and `scripts/` — excluding `tests/` and
`bin/`. There is no site workspace to keep in sync, so the single-source guard
watches the one thing it can still see: a tool that ships without being documented
in `SKILL.md` or in this file fails the build.

## 4. The spine

`check.mjs` is the composition entry point for a claim already made: reproduction,
optional history search, check/probe, re-run, and storage. It writes its human table
to stderr and machine result to stdout. The letter is an **evidence-completeness
score, not causal confidence**. A contradicted prediction or failed verification
cannot be averaged into a positive grade; a bisect hunk miss alone is not proof
of a wrong cause. Tool-documentation guards match exact filename tokens, so
`run_check.mjs` cannot accidentally document `check.mjs`.

```
 invoke ─▶ 1 REPRODUCE ──exit 1──▶ does_not_reproduce → write_case → STOP
                │ exit 0
                ▼
           2 SEED CANDIDATES  (≤5, nearest fault first)
                │   bisect.mjs, when a green ancestor exists: the blamed commit and
                │   its hunks become a candidate, and `claim_in_commit` grades any
                │   claim already made against them
                ▼
           3 FALSIFY one candidate ──falsified──┐
                │ confirmed                    │ (≤ depth ceiling, needs --escalate
                ▼                              ▼  to go past an inconclusive lead)
           4 CASE FILE  ◀──────────────────────┘
                ▼
           5 MEMORY  (rap sheet next time; nothing may skip the gate)
```

| Step       | What is guaranteed, not asked for                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproduce  | The command runs through the user's shell; exit 0 ⇒ `does_not_reproduce` **with zero candidates**; a failure with no in-repo evidence ⇒ `error`; exit 1 is the hard stop (§5) |
| Candidates | Ranked by parsed traceback order + fail-only coverage, capped at 5, dependency frames last, ids are file:line                                                                 |
| Falsify    | Hypothesis required; the check is executed; verdict = arithmetic; `--control` must pass or nothing is concluded                                                               |
| Case file  | Schema + policy validated at the store boundary; Markdown mirror generated from the same object                                                                               |
| Memory     | Append-mostly JSONL keyed by id; overlap ranking shared with the site's demo                                                                                                  |

### Exit-code contract (the host's API)

| Tool               | 0                                        | 1                                           | 2                                           | 3                          |
| ------------------ | ---------------------------------------- | ------------------------------------------- | ------------------------------------------- | -------------------------- |
| `reproduce.mjs`    | reproduced — continue                    | does not reproduce — **stop**               | harness error / command never ran / timeout | —                          |
| `run_check.mjs`    | verdict recorded                         | refused (state, sequence, depth, unsafe id) | inconclusive / bad args                     | dry run, nothing executed  |
| `query_memory.mjs` | printed (an empty store is a normal day) | —                                           | bad args                                    | —                          |
| `write_case.mjs`   | stored                                   | refused: the case breaks a rule             | invalid JSON / harness                      | —                          |
| `bisect.mjs`       | first bad commit found                   | refused: dirty tree, budget exceeded, bad   | no good ancestor, flaky repro, no candidate | dry run: the plan, nothing |
|                    |                                          | args                                        |                                             | moved                      |
| `bin/install.mjs`  | installed (or planned)                   | refused: you edited a file                  | bad args / download failed                  | —                          |

stdout is always machine-parseable (JSON or a usage line); prose goes to stderr.

---

## 5. Where the discipline actually lives

The premise of the whole design: an agent under pressure to answer reads prose as a
suggestion. So every rule that matters is a **type error at a boundary**, not an
instruction.

**Who decides what.** The host model owns every judgement call; the tools own every verdict.
The model reads the failing run, writes the one-line hypothesis, picks the smallest disproof,
and declares what it expects to happen. It is never the thing that grades itself:

| Decision                                                                          | Owner                                   | Mechanism                                                                                  |
| --------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| What the symptom means; the hypothesis; which check disproves it; what to predict | host model                              | prose in the draft                                                                         |
| Did it reproduce, and where to look first                                         | `reproduce.mjs`                         | exit code + the evidence rule; candidates seeded in frame/coverage order (§8)              |
| `confirmed` / `falsified` / `inconclusive`                                        | `run_check.mjs classify()`              | `(predicted === "pass") === (exit === 0)`, after the timeout / unrunnable / control checks |
| May the next candidate be tested                                                  | `run_check.mjs blockers()`              | an earlier `pending`, `inconclusive` or `confirmed` lead keeps it shut                     |
| Does the claim still stand                                                        | `run_check.mjs --verify`                | re-runs that candidate's own oracle, writes `verified_verdict` only                        |
| May any of this be stored                                                         | `write_case.mjs` → `policyViolations()` | schema + rules 1–8 as refusals                                                             |

The model's output is a _prediction_; the store accepts only a verdict that agrees with the
exit code that prediction implies. A confident wrong answer is not merely discouraged here —
it is unrepresentable in `cases.jsonl`.

| Rule (SKILL.md)                                              | Enforcement                                                                                                                                                                                                             | Where                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1–2. No reasoning without reproduction                       | a non-reproducing case must carry **zero** candidates; a stopped draft is writable, a speculated one is not                                                                                                             | `policyViolations()`                                        |
| 3. Never more than five candidates                           | `"maxItems": 5`; `--max-candidates` clamps loudly                                                                                                                                                                       | schema + `reproduce.mjs`                                    |
| 4. A verdict is an executed oracle                           | verdict requires `predicted` **and** numeric `check_exit_code`; a verdict contradicting its own exit code is refused ("predicted pass, exit 1 ⇒ falsified")                                                             | `policyViolations()` + `classify()`                         |
| 5. A check that fails everywhere proves nothing              | `--control` that exits non-zero ⇒ `inconclusive`, and a `confirmed` beside a failed control is refused                                                                                                                  | `run_check.mjs`                                             |
| 5. A check that never touched the line proves nothing either | `--probe` comments the accused line out on a scratch worktree and re-runs the check; no change ⇒ `inconclusive_vacuous`, and `write_case` refuses any `confirmed` carrying neither a passed control nor a flipped probe | `run_check.mjs probe()`, `classify()`, `policyViolations()` |
| 6. Never confirm in prose                                    | hand-typed verdicts have no provenance to cite ⇒ refusal                                                                                                                                                                | schema + policy                                             |
| 7. No patch before a confirmed cause                         | `suggested_patch` requires `status: confirmed`; `high`/`medium` confidence too                                                                                                                                          | `policyViolations()`                                        |
| Speed control                                                | a `pending` **or** `inconclusive` **or** `confirmed` earlier lead blocks the next; `--escalate` overrides deliberately; `--depth 1` forbids escalation                                                                  | `blockers()`                                                |
| Not a sandbox                                                | `--yes` or nothing, with the exact command printed first; no denylist (any `&&` defeats one)                                                                                                                            | `run_check.mjs` header                                      |

**The evidence rule.** "Reproduced" is not inferred from vocabulary. A non-zero
exit is a reproduction only if the run left evidence _inside this repo_: a
traceback frame or a fail-only coverage line. This rule exists because a real
third-party repo (`ref/scientific-agent-skills`) exited 2 with
`ERROR: cannot collect 105 skills in one process` and matched no known error
string — it was filed as a reproduced bug. `RUNNER_MISUSE` now only chooses the
wording of the note.

**Pseudo-locations are not files.** `[eval]`, `<string>`, `<stdin>` have no
separator and no drive, so "not absolute" read them as in-repo evidence;
`isLocalFile()` rejects them. Path classification is deliberately done with pure
string helpers (`baseName`, `isAbsoluteLike`) rather than `path.isAbsolute`/
`path.basename`, which answer per-OS — that bug shipped green on Windows and red
on CI.

**Vendored code is not the project's code.** The first real run — a bug in
`WebPointCloud`, a repo this project did not write — filled all five candidate
slots with `.venv/Lib/site-packages/_pytest/*` and never named the failing file,
which made "dependency frames last" false for the dependencies a repo keeps in
its own tree. `VENDORED` (`.venv`, `venv`, `node_modules`, `site-packages`,
`.tox`, `vendor`, `__pycache__`) is now folded into `isLocalFile()`, so those
paths neither lead nor count as evidence — in the traceback frames **and** in the
coverage sites. Because a warning escalated to an error reports its origin inside
`_pytest/python.py`, the run would then have read as "nothing landed in this
repo": `TEST_NODEID` (`path.py::Class::test`, which pytest prints itself) is the
second form of in-repo evidence, and it is what keeps that reproduction a
reproduction.

**Ids are filenames.** `.ducktective/cases/<id>.md` and
`ducktective-check-<id>-<rank>.<ext>` are built from a **model-authored** draft, so
`^DT-[A-Za-z0-9][A-Za-z0-9-]{0,31}$` is a containment guard: `^DT-` let
`DT-../../pwned` write outside `cases/` and `DT-../../../tmp/evil` write — and then
execute — outside the repo. `writeCase()` re-checks it so an unvalidated caller
still can't aim a write.

---

## 6. Data contract

`case-file.schema.json` is canonical. Case fields:

```
id · opened_at · symptom · reproduction · candidates[]
confirmed_cause · leading_hypothesis · confidence · suggested_patch · status · notes
```

- `status`: `open` (mid-flight, patching forbidden) · `confirmed` ·
  `does_not_reproduce` · `exhausted` · `unverified`. A run that never executed is
  `unverified` with the harness reason in `leading_hypothesis` — `error` describes
  the reproduction, never the verdict.
- `reproduction`: `command`, `outcome`, `exit_code`, `duration_ms`, `runner`,
  `stdout`/`stderr` (head **and** tail kept — the exception is at the end),
  `stack` (verbatim frame lines), `covered` (`{file,line}` fail-only sites).
- `candidates[]`: `rank`, `location`, `why`, `hypothesis`, `check`, `verdict`,
  `evidence` + the provenance chain `predicted`, `check_exit_code`, `control`,
  `control_exit_code`, `verified_exit_code`, `verified_verdict`.
- `additionalProperties: false` at every level, so a misspelled field is a
  validation error rather than a value that silently reads as `undefined` in the
  site and the rap sheet.

**Store:** `<repo>/.ducktective/cases.jsonl`, one line per case id, rewritten in
place as verdicts arrive (design doc L112 as amended — strict append would pile up
copies of every half-answer). Unparseable lines are preserved verbatim, never
dropped by a rewrite. JSONL and Markdown are written through the same helper via
temp-file + rename, so a crash cannot half-write either. `repoRoot()` walks to
`.git` and **falls back to the starting directory**, never the filesystem root.

---

## 7. Execution layer (`scripts/lib/exec.mjs`)

One place where the OS realities live, shared by `reproduce` and `run_check`. Every
item below is a bug that already happened:

- `shell: true`, one command string — `--cmd` is human input with pipes and `&&`,
  and Windows will not resolve a `.cmd` shim otherwise. Never `spawn(exe, args,
{shell:true})`: node concatenates instead of escaping, so
  `-c "import coverage"` arrived as two words and every probe "failed".
- **Tree kill**: `detached` + `kill(-pid)` on POSIX, `taskkill /T /F` on Windows.
  Killing the shell alone left a hung `pytest` holding the port.
- **`NODE_TEST_*` scrubbed** from the child env — a nested `node --test` that
  inherits them exits 0 and prints nothing, which the gate read as "does not
  reproduce".
- **Bounded capture**: chunks accumulated as Buffers to a hard ceiling, decoded
  once, then head+tail clipped. A 400 MB `pytest -s` used to OOM the harness and
  per-chunk decoding split multibyte output.
- **The repo's own interpreter.** A materialized multi-line python check runs
  under `.venv/Scripts/python.exe` / `.venv/bin/python` (or `venv/`) when the repo
  has one, because global `python` is the machine's and has none of its deps. On
  that real run the global interpreter exited 1 with
  `ModuleNotFoundError: No module named 'pytest'`, and the arithmetic filed the
  hypothesis as **falsified** — a check that never tested anything, recorded as a
  check that disproved it.
- **Atomic writes** and **`exitCode`, never `process.exit()`** — stdout to a pipe is
  async and can be truncated with the JSON half-written.

`--probe` (run_check) is the discrimination the arithmetic otherwise cannot see: a
neuter is written into a scratch `git worktree` at HEAD, never the user's tree, and
the check re-runs there against the mutated file. It **deletes** the accused line
rather than aborting before it, because a check that already fails keeps failing when
code above it dies, which would call every failing check vacuous. A neuter that
breaks the parse or leaves a name undefined is reported as `not-run`: "crashed
differently" is not "behaved the same". `bisect.mjs` cannot use the same isolation —
a scratch worktree has no untracked `.venv` or `node_modules` for the repro to run
in — so it moves HEAD in the user's tree, refuses a dirty one, and restores the
branch or commit it started from.

`run_check.mjs --verify` re-executes a decided candidate's own oracle and records
`verified_verdict` without letting it rewrite the claim; a claim that did not
survive cannot be filed as standing. Stated limit, printed by the tool: same
machine, same working tree, new process — it catches a flaky oracle, not an
environment-specific pass. Re-execution reads the source back through
`checkSource()`, which drops the recorded command line written above it: feeding
that field in raw made the command the script's first line, so every multi-line
check died on a SyntaxError and **M3 could not be computed at all** — the metric
the project is judged on was unmeasurable by construction, and only a run on
someone else's repo found it.

---

## 8. Runner and language support

| Input                                  | Status                                                                                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `python -m pytest`                     | **verified** — including pytest's rewritten `file:line: message` form, which is _not_ a Python traceback (parsing only `File "…", line N` made every real pytest failure look like zero frames)                                                                             |
| `python -m unittest`                   | **verified**                                                                                                                                                                                                                                                                |
| plain `python script.py` / `python -c` | **verified** — no runner name, so frame order comes from the matched syntax                                                                                                                                                                                                 |
| `node --test`, plain `node file.mjs`   | **verified** — `node --test` reports failures on **stdout**; runner detection is command-based, then TAP markers                                                                                                                                                            |
| `coverage.py` JSON                     | **verified against real coverage.py 7.16** — `executed_lines`, fail-only diff vs `--baseline`; each phase starts from a clean `.coverage` or the diff is empty                                                                                                              |
| anything else                          | command-generic: frames fall back to `unknown`, no candidates, `--max-candidates`/`--timeout`/`--coverage` still apply                                                                                                                                                      |
| `tsc` / compiler diagnostics           | **verified 2026-09-15 on `floorplanner`** — `packages/solver` failing `npm run typecheck` produced 7 frames and 5 candidates in compiler order (`DIAG_FRAME`); the same command was refused as "nothing landed in this repo" an hour earlier, before that syntax was parsed |
| jest/vitest/rspec/go test              | **not verified** — same parser family, unproven; treat frame order as suspect until a case exists in `evals/cases/` (vitest has now run green twice under `reproduce.mjs` only as a _passing_ control, so its failure frames are still unseen)                              |

---

## 9. The website (`site/`) — deleted 2026-09-15

Five routes, a browser engine, a view model, a schema↔site sync guard, and six npm
dependencies existed to demo a claim that has never been measured (§16). The engine
re-implemented the spine instead of using it, its ranking path had no tests, and the
guard existed only to keep the re-implementation honest — complexity paying rent on
complexity. The site is gone, along with its workspace, its Vite deploy workflow and
the sync test. What stays: `SKILL.md` as the one source of the contract (§11), and
`cases.jsonl` as the artifact a human reads.

If it comes back, it comes back after the benchmark (§4 of the design doc) has a
table worth rendering, and it renders that table — not a simulation of the tool.

## 10. Packaging and distribution

| Path            | Command                                                               | Verified?                                                                                          |
| --------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Clone installer | `node skills/ducktective/bin/install.mjs --target claude [--dry-run]` | **yes** — file placement, idempotent re-run, edited-file refusal, installed copy running its tools |
| Any other agent | `--dest DIR`                                                          | the general case; no target is claimed for a scanner nobody has checked                            |

Two targets (`codex`, `agents`) and the Claude Code plugin marketplace manifests were
deleted on 2026-09-15: distribution surface for a product with no demand signal, and
each guessed target cost a test to keep honest. `--target` now accepts `claude` and
refuses the retired names, so a silent no-op install is not reachable.

**Retirement propagates, if asked.** The installer only adds and updates, so a tool
deleted upstream survives in every installed copy — `query_memory.mjs` was still installed
(§13) after the repo removed it, a zombie a host agent would happily call. Any file under
`dest` that the source no longer ships is reported as `stale` in the JSON and **removed
only with `--force`**, because a file in that folder may be somebody's own addition.

**Upgrade is `--force`.** The installer compares contents and refuses to overwrite a
file that differs from what it would write — right about a user's hand-edits, wrong
about `git pull`, which makes every installed file look hand-edited. It says so and
lists the files; nothing is clobbered either way.

Skill-only by design (§1): a thin set of tools the host agent can call beats an MCP
server because there is no daemon, no install step, and the artifact is a file
another skill can read.

## 11. Measurement

Four layers, cheapest and most mechanical at the bottom — the fourth is not a test, it is
the only one that measures the product.

1. **Guards** (`scripts/*.test.mjs`) — single-source SKILL.md; schema↔site
   agreement; plugin/manifest and README↔installer agreement; run-log parsing;
   architecture/tool coverage. The reference check asks **git** whether
   `docs/architecture.md` is tracked rather than reading the file: a stray ignore
   rule made the reference exist locally and be absent on CI, twice, and reading the
   file could not tell those two states apart.
2. **Unit + integration tests** (`npm test` prints the count; a number checked
   into prose rots the moment a test is added): frame order, evidence rule,
   pseudo-locations, id containment, policy refusals, tree-kill, bounded capture,
   installer behaviour.
3. **Behaviour corpus** — one directory per case under `evals/cases/` (`ls` for the
   count), each driving a **real** command: pytest, unittest, a plain script,
   node:test, a module throw, a genuine coverage.py diff, non-reproducing stale/green
   runs, and broken-invocation shapes that must be refused rather than filed as
   reproduced. `npm run eval` runs it on CI with real pytest and coverage.py and
   prints the tally. Every case is **self-authored**, so the result is a regression
   net, never evidence about the product (design v2 §4).
4. **Run log** — `evals/runlog.mjs` + `RUNLOG.jsonl`, one row per investigation with
   `provenance = real | constructed`, because `ref-work.md` §8 says to measure on
   repos nobody chose for us and say so. `--report` prints **M1–M4** (one list, shared
   by the plan and the tool), split into all-rows and real-rows-only, printing
   `no data` where a row has none instead of inventing a zero. Columns:
   `stop_correct`, `first_falsification_hit` and `survived_verify` are **derived from
   the case file**; `decision_changed` is the one column a human answers, and `note`
   is free text. A blank leaves a metric's denominator (it means nobody looked);
   `no data` and `0%` are different facts and the report keeps them apart.
   **M5–M9 were deleted on 2026-09-15** — `memory_changed_search`, `pair_case_id`,
   `human_opened`, `tokens_plain`/`tokens_duck`, `wall_clock_min`, `duck_claim_right`,
   `plain_claim_right` — every one of them a human transcribing a judgement about
   their own run, which is how the project's headline number became its least
   mechanical column. Passing those flags now fails with a pointer to the replacement
   instead of dropping the data silently; `RUNLOG.jsonl` keeps whatever the old rows
   recorded, because history is not rewritten to fit a smaller schema. Design §4
   replaces them with cause-hit, false-confirm rate and cost measured mechanically
   against a corpus with known answers.
   New columns keep legacy rows short, and `read()` maps absent fields to empty, so a
   migration cannot mis-shift or destroy a row. `--record` is an **upsert by case id** —
   re-logging after `--verify` refreshes the row and inherits every answer it did not
   restate, because two rows for one investigation would double each metric that case
   feeds. Current numbers are never restated here —
   `node evals/runlog.mjs --report` is the only source, and §16 records the state as of a
   date.

**What no layer could see.** Two first-run defects survived a green suite and a green
corpus: `--out .ducktective/draft.json` (the path in `--help`'s own example) died with
ENOENT because nothing creates the store directory, and the default `--cwd .` never
matched an absolute frame path, so node's `file://` URLs and Python 3.13+ tracebacks all
read as outside the repo — a real reproduction filed as `error` with zero candidates.
Both harnesses passed an absolute `--cwd` and pre-created the output directory, so neither
could reach the documented default path. The regression tests now **omit** those arguments
on purpose, which is the durable lesson: a helper that normalises the environment for the
tool under test also deletes the environment the user gets.

The same lesson repeated on the first run against someone else's repo, three more defects
(plus the one that made this section's headline true: an always-pass oracle confirmed any
prediction with full provenance until `--probe` existed, and the skill's own documented
example command was that oracle):
vendored `.venv` frames ranked as leads (§5), a materialized check ran under the machine's
python and reported a `falsified` it never tested (§7), and `--verify` could not re-execute
a multi-line check, so M3 was unmeasurable (§7). Every one of them was invisible for the
same reason — the corpus is **self-authored**, so its frames are never vendored, its
interpreter always has its deps, and nothing re-runs a check it just recorded. A regression
net written by the thing it tests cannot see the world the tool meets; that is the whole
argument for the run log.

The field-study kill criterion (ref-work §8: "if nobody opens the case files, the
differentiator is theoretical") is **retired, not answered**. Design v2 §4 replaced it: a
human-graded sample of 10–15 bugs cannot reach significance (3–0 under the null is p=1/8),
and every input to it was the author remembering to run a baseline and then judging his own
run. The decision now belongs to the mechanical table in design v2 §4 — cause-hit,
false-confirm rate, cost — and M4 (`decision_changed`) survives only as the one
human column in a ledger whose other four are derived from the case file.

Docs cite each other by **section, never line number** — line numbers rot on the next
edit, the same failure class as a test count checked into prose.

---

## 12. What is genuinely different here

`ref-work.md` §1 is blunt that graph + LLM + memory is table stakes, not a moat.
Its §7 five pillars, mapped honestly:

| Pillar                                            | State                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1. Silent/oracle-free bugs via metamorphic checks | **parked** (§13); `bisect` + `--probe` are the two mechanics that replaced the claim                   |
| 2. Evidence chain as the product                  | **built** — schema, Markdown mirror, enforced provenance, and the receipt is the artifact              |
| 3. Preventative cold scan over `hidden_links`     | **parked**                                                                                             |
| 4. Persistent memory, honestly measured           | store kept, `query_memory.mjs` **retired** — no measurement has ever shown it changed a decision (§13) |
| 5. Packaged as a Skill, not an agent              | built; but it is a **distribution** moat, perishable by §8 — someone can wrap the same parts           |

The defensible part in practice is narrower than the pitch and is §5: **the
enforcement.** Existing debug skills instrument and hypothesise; the ones that gate
gate on a human's judgement. Here a verdict is a stored exit code plus a declared
prediction, checked by a program that will not write the file otherwise.

Say the honest size of that evidence, though: it has refused **two** wrong claims, in
one day, both authored by the person writing this sentence, and confirmed nothing a
terminal could not have found (§16). The arithmetic was hardened by five defects —
two caught by a throwaway repo walk, three by running the tool against someone else's
code — and **zero** caught by the self-authored corpus that seemed to cover it.

---

## 13. Deliberately parked, with the trigger that un-parks each

| Item                                   | Would be built as                                                                                                                                                            | Un-parked when                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Oracle-free / metamorphic checks       | a `run_check` mode that tests invariants under input transforms instead of an existing failing test, and says confidence is lower for it                                     | real bugs arrive with **no failing test** (ref-work §4.2, §7.1) |
| Cold Scan                              | a separate lower-priority command reading an existing tree-sitter graph (e.g. `graphify`) for drift/duplication, logging candidate cases to the store — never a graph we own | the reactive loop is used and trusted                           |
| One-hop graph expansion                | a candidate _provider_ plugged into `seedCandidates`, results thrown away after ranking                                                                                      | local frames are insufficient on real bugs (design L65)         |
| Alibi diagnosis of which step misled   | record whether motive, ranking, or expansion produced a bad lead, and replay from there                                                                                      | confirmed claims keep failing `--verify` (ref-work §6.3)        |
| Rap sheet ranking (`query_memory.mjs`) | delete `query_memory.mjs` and its site twin; the JSONL store stays and `grep` is the reader                                                                                  | a benchmark shows "nearest previous case" changes a decision    |
| Metamorphic/oracle-free checks v2      | construct-aware neuter strategies (sentinel return, inverted condition, perturbed constant)                                                                                  | line-deletion probes miss causes a corpus proves they share     |
| SQLite store                           | a swap behind `readStore`/`writeCase` only                                                                                                                                   | JSONL stops being greppable at real volume                      |

---

## 14. Known limits

- **Two real confirmed cases, both in the author's own repos, and neither paired.**
  `--report` is the only source for the counts. That demonstrates the instrument fires
  on foreign code; it is not a rate, and the comparison the project lives or dies on
  (arm A vs arm B) has never been run (design v2 §4).
- **Upgrading an installed skill needs `--force`.** The installer refuses to overwrite
  files that differ from the source, which is right about a user's hand-edits and wrong
  about `git pull`: after updating the checkout, every target looks "hand-edited". It is
  refused loudly, with the file list, so nothing is clobbered either way.
- `--verify` is same-machine/same-tree; it is not a portability or flakiness suite.
- **Cost is not visible to a subprocess.** A tool run by an agent cannot see the host's
  token count, which is one reason the hand-transcribed M6/M7 columns were deleted rather
  than kept; in the benchmark they come from the agent's own usage record instead
  (`pi --mode json` reports `usage` per message), so the number stops being a memory.
- **The arms are not run yet.** `bench/` drives them through `pi --mode json`, which
  fixes the two failures that killed the field study: the baseline is generated by a
  fresh agent, not remembered by an author, and pairing is by construction rather than
  by whether somebody recalled to run it first.
- **A provider error must never score as an abstention.** The first smoke run on this
  machine came back `429 FreeUsageLimitError` with an empty message and `stopReason:
"error"`. Scored naively, that reads as "the bare agent refused to name a cause" — a
  win for arm B bought by a rate limit. `bench/` records errored arms as `error` and
  drops them from every denominator, and the runner refuses to score a run with no
  assistant message at all.
- **`--probe` deletes one line.** It proves the check depends on _this_ line, not that
  the line is wrong, and a construct-aware neuter (sentinel return, inverted condition)
  catches more shapes. `MUTATION_ARTIFACT` keeps a broken parse from being read as
  vacuity, which is the honest failure mode rather than the confident one.
- **`bisect` answers only regressions.** A bug that was always there has no green
  ancestor and gets `no-good-ref`, which is a finding, not a failure. The blamed commit
  is the one that made the test fail; an enabling change can expose an older defect, and
  the tool prints that caveat rather than pretending to have found the origin.
- **Neither `--probe` nor `bisect` works on a tree it cannot build.** The worktree has no
  untracked deps; the bisect does, but only because it runs in the user's working tree.
- Frame parsing for jest/vitest/go/rspec is unproven (§8).
- **Candidate ids carry the tool's cwd, not the repo root's.** A workspace
  compiler prints `tests/tmp-ext.test.ts(32,5)` while the command ran at the repo
  root, so the seeded id is `tests/tmp-ext.test.ts:32` for a file at
  `packages/solver/tests/tmp-ext.test.ts`. The text is verbatim from the failing
  run — inventing a prefix would be guessing where the tool was standing — so
  `--repo`-relative paths stay a human step (§8).
- **M1 cannot see a false stop.** It counts every `does_not_reproduce`/`error` row as
  a correct stop, including one caused by a parser gap in this skill (a real
  `npm run typecheck` failure refused an hour before the fix). The metric is an
  upper bound on stop-correctness and its denominator silently grows with our own
  defects; nothing in the ledger distinguishes "stale ticket" from "we could not
  read the output".

---

## 15. Where to change things

| To                                       | Change                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| a new test runner's frames               | `parseFrames` in `reproduce.mjs` + a corpus case in `evals/cases/`; never a runner-name branch for ordering                              |
| a new hard rule that must be unskippable | `policyViolations()` in `lib/case-file.mjs` + a refusal test (prose in `SKILL.md` alone will not hold)                                   |
| a case-file field                        | `case-file.schema.json` (and `renderMarkdown` in `lib/case-file.mjs` if a human should see it)                                           |
| a new way to believe a verdict           | `classify()`'s receipt gate in `run_check.mjs` + the mirror rule in `policyViolations()` + a refusal test                                |
| the commit search                        | `bisect.mjs`: the `rev-list` walk and `at()` are the whole engine; `claimInCommit` is the grading, `parseTouched` the input              |
| a new tool                               | `scripts/<name>.mjs`, document it in `SKILL.md` (a guard requires the mention), and it is auto-shipped by the installer's `skillFiles()` |
| a policy about escalation                | `blockers()` in `run_check.mjs`; keep `--escalate` the only override                                                                     |
| anything OS-facing                       | `scripts/lib/exec.mjs`, and ask whether a path decision should be a pure string helper instead                                           |
| a numeric CLI flag                       | `numFlag()` in `scripts/lib/args.mjs` — three tools hand-rolled the same range check once and each got it subtly wrong                   |
| the ledger's metric set                  | `FIELDS` + `summarise()` in `evals/runlog.mjs`, and design §4's benchmark replaces hand-graded metrics rather than adding new columns    |

### Invariants — do not break

1. `SKILL.md` exists in exactly one place, and the installer ships it verbatim.
2. Nothing executes without `--yes`; no denylist pretending otherwise.
3. A verdict is only storable with `predicted` + `check_exit_code`, and must agree
   with them. A `confirmed` additionally owes a discrimination receipt: a control that
   passed or a probe that flipped. Agreement is not evidence.
4. `does_not_reproduce` ⇒ zero candidates.
5. `reproduced` ⇒ in-repo evidence; none ⇒ `error`.
6. Statuses and verdicts stay inside the schema enums; `additionalProperties: false`
   stays on.
7. Ids never reach a filesystem path unchecked.
8. There is no site, no server, no DB, no auth. The store is a file; the artifact is
   a Markdown mirror a human opens.
9. Path classification stays host-independent (no `path.isAbsolute`/`basename`
   decisions that flip between Windows and CI).
10. No claim ships without a receipt: each number on a page carries a source and a
    date, and each metric in `RESULTS.md`/`RUNLOG.jsonl` states its provenance.

---

## 16. State of play (dated snapshot — invariant 10)

As of **2026-09-15**. Everything below is a pointer to a command, because the moment a
live number is copied into prose it starts rotting.

| Question                             | Ask                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Do the tools still behave?           | `npm test` (unit + guards) and `npm run eval` (behaviour corpus, real pytest/coverage) |
| Does a verdict mean anything?        | `run_check.mjs --probe` on a real claim: `inconclusive_vacuous` is the honest answer   |
| Can it find a commit?                | `bisect.mjs --cmd "<repro>" --claim file:line --yes` in a repo with a regression       |
| Has the skill ever found a real bug? | `node evals/runlog.mjs --report` — reproduced cases are the M2 denominator; read it    |
| Did CI pass on the pushed branch?    | `gh run list --limit 5`                                                                |
| What ships?                          | `node skills/ducktective/bin/install.mjs --target claude --dry-run`                    |

**The verdict, stated as plainly as the receipts allow (2026-09-15):**

- **Discovery value: none demonstrated.** Both real causes fell out of ordinary
  commands — `npm run typecheck`, and a pytest warning escalated to an error. The skill
  saw nothing a careful engineer with a terminal would not have seen. Anyone reading a
  claim here that it "finds bugs agents miss" should stop: §1 promises reproduction,
  falsification and a record, not clairvoyance.
- **Enforcement value: two catches, both on the author, both same-day.** A designer bug
  report with a file, a line and a plausible `why` — refused by rule 2, and the ticket
  died ten minutes later under a real commit. And floorplanner's tempting wrong fix
  (`lib: ["DOM"]`, which turns the gate green and hides two assertion-free tests) — the
  third fact of the oracle is what says not to. n=2, self-witnessed, exactly the
  denominator design v2 §4 distrusts. It shows the mechanism is not theatre; it does
  not show it works.
- **The metric that decides the project has never been run: M9 paired = 0.** The author
  skipped the bare-baseline rule twice in one day while doing nothing else. If a protocol
  cannot survive its own author's hurry, the ceiling on this project is adoption cost, not
  code quality — and that is a product finding, not a footnote.
- **What did pay for itself was a different thing entirely:** pointing the tool at foreign
  repos surfaced four defects in this one (vendored frames, venv-blind checks, `--verify`
  un-runnable, ledger double-count) that 119 unit tests, 14 corpus cases and a green CI all
  missed. That is evidence about self-authored tests, not about debugging.
- **Therefore: unproven, with the cheap half of the pitch disproven.** Not worthless —
  unfalsified so far, because the one comparison that could falsify it has not been run.
  The decision belongs to design v2 §4's table: if arm B's false-confirm rate (C2) does
  not drop by ≥10 points at ≤2× the tokens, the correct action is to archive this repo
  with its receipt and keep `bisect` + the probe, not to keep polishing the instrument.

- **Built and checkable:** the spine (gate → commit search → oracle + probe → case file),
  enforcement at the store boundaries, one installer target, and an M1–M4 ledger whose
  hand-transcribed columns are gone rather than half-filled. The website, the plugin
  manifests, two installer targets and `query_memory.mjs` were deleted on 2026-09-15
  (§9, §10, §13): maintenance surface for a claim with no demand signal behind it. The documented spine now runs end to end in a repo
  that has never seen the skill — first in a throwaway git repo, which is how the two
  default-argument defects in §11 were caught, and now in a real one, which is how the
  three in §5/§7 were.
- **Two real cases, both confirmed on the first candidate, both surviving `--verify`:**
  `DT-260915-b84fdc` in `WebPointCloud` (a 3DGS overflow probe that `return`s its flag
  where it should assert, so it cannot fail) and `DT-260915-50b158` in `floorplanner` (a
  committed debug leftover: `tests/tmp-ext.test.ts` logs `ext.info`, a field
  `ConstraintEvaluation` does not declare, and `console` under a `lib` that excludes it,
  while asserting nothing). Both were found by the **installed** skill. The second one
  only worked because of the first: `tsc`'s `path(line,col):` diagnostics were refused as
  "nothing landed inside this repo" until `DIAG_FRAME` shipped the same evening (§8).
- **Not built, by policy:** everything in §13. The triggers are evidence-shaped and none
  has fired — including the one that could have been satisfied with zero users (design §7),
  which the first real case came close to firing and did not, for a reason design §7 now
  writes down rather than implies.
- **Unproven:** value at any scale. One case proves the instrument fires on someone
  else's code; §9 is a _rate_, and a denominator of one is not one. The bare-run
  comparison (M8 vs M9) has never been made, so the sentence "it reduces confident wrong
  answers" is still unevidenced in both directions.
- **Waiting on a human, not on code:** the design §4 benchmark — a corpus with known
  answers, cause-hit against gold hunks, arm A vs arm B with no author in the loop — and a
  decision date for it (2026-09-29 proposed, unconfirmed). The field study's M5–M9 are
  retired, so nothing waits on memory pairs or hand-graded baselines any more.
- **Still unexercised:** a host agent that _discovered_ the skill rather than being told
  where it lives — this run followed the installed `SKILL.md` by hand, and Claude's
  `/plugin install` and Codex's own scan are still unproven (§10, §14). And **no stranger
  has ever used it**: every ledger row, including the two confirmed cases and both stops,
  was produced by the author, on his own machine, against repos he already works in.
- **Repo plumbing that has bitten five times:** `docs/` must stay tracked — the guard suite
  reads `docs/architecture.md`, and commits that carry modified files while dropping
  newly-added ones leave CI red on a pushed branch. The tracked-not-present check in §11 now
  fails locally within one command, so this cannot hide silently again — which is how it was
  found in `8d3583f`/`5f4af8e`, again on 15 Sep, and a third time that evening. **Who did it
  is not known, and the sentence that said "something outside the repo" was itself the defect
  this project exists to prevent: an unfalsified causal claim, bolded, asserted by the person
  holding the file.** What is known, as of 23:40 the same evening:

  - `git log -p -- .gitignore`: a bare `docs/` was **added by `1dc6d09`** (13 Sep) and removed
    by `5f4af8e`. It is not foreign to this repo; sessions working in it have written it.
  - `vitruvius/.gitignore:9` carries the same bare rule, committed by `0f670af` (11 Sep) in a
    cleanup that moved files out of `docs/`. Same hand-shaped event, different repo.
  - It is not a git mechanism: no `core.excludesFile`, no `.git/info/exclude` entry, no hooks,
    no `core.hooksPath`. `strings` on `graphify.exe` names no `gitignore`, and this repo has no
    `graphify-out/`, so the obvious suspect is unsupported too.
  - The filesystem gives one event, not a culprit: `.gitignore` mtime 22:59:13 with no other
    file touched in the repo between 22:56 and that moment; the next write (23:01:54) was the
    removal.
  - Separate and worse in consequence: an external paste overwrote `architecture.md` with a
    critique and **emptied** `ducktective-design.md` and `ref-work.md` to zero bytes; both were
    recovered from the git index, which is the only reason they still exist. The commit that
    followed (`b576d1d`) shipped 8 files and no reference at all, though docs were staged when
    it was written.

  Best-supported reading: an agent session in this home directory, doing what two of them have
  demonstrably done before. Settling it would mean watching the file across a session, which is
  not worth the time — what was worth doing is neutralising it: `git add -f docs` (a force-added
  path stays tracked whatever the ignore file says) and recovering the reference from the index
  instead of from memory. The guard can still only fail loudly afterwards.
