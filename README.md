# Ducktective

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Deploy site](https://github.com/adeerkhan/ducktective/actions/workflows/deploy-site.yml/badge.svg)](https://github.com/adeerkhan/ducktective/actions/workflows/deploy-site.yml)
[![Skill stress run](https://github.com/adeerkhan/ducktective/actions/workflows/eval.yml/badge.svg)](evals/RESULTS.md)
[![Agent Skills](https://img.shields.io/badge/Standard-Agent_Skills-blueviolet.svg)](https://agentskills.io/)
[![Node](https://img.shields.io/badge/Node-20.19%2B-green.svg)](skills/ducktective/scripts)

An [Agent Skill](https://agentskills.io/) that stops a coding agent from producing a
confident, plausible, **wrong** root cause. It makes the agent reproduce the bug before it
reasons about it, requires an executed check that could have disproved each candidate, and
leaves a case file a human can read in 30 seconds.

It is a contract the host agent is walked through, not a runtime. It does not index your
repo, run a server, need an API key, or take a dependency beyond Node's standard library.

```
Ducktective, investigate this failing test.
```

> **Honest status — 2026-09-14.** Ducktective has never confirmed a real bug in code it did
> not write. The run log holds three investigations and zero reproductions; every `confirmed`
> case so far was produced against a fixture authored for this repo. What is verified here is
> _behaviour_, not _value_. The receipts are `npm test`, `npm run eval`, and
> `node evals/runlog.mjs --report` — this file deliberately quotes no test counts, because a
> number copied into prose starts rotting the moment someone adds a test.

**Site:** <https://adeerkhan.github.io/ducktective/> ·
**Skill:** [`skills/ducktective/SKILL.md`](skills/ducktective/SKILL.md) ·
**Design:** [`docs/ducktective-design.md`](docs/ducktective-design.md) ·
**Architecture:** [`docs/architecture.md`](docs/architecture.md)

---

## Install

From a clone — two commands, no dependencies:

```bash
git clone https://github.com/adeerkhan/ducktective && cd ducktective
node skills/ducktective/bin/install.mjs --target claude
```

| Target            | Installs to                                                                |
| ----------------- | -------------------------------------------------------------------------- |
| `--target claude` | `~/.claude/skills/ducktective`                                             |
| `--target codex`  | `~/.agents/skills/ducktective` — Codex scans `.agents/skills`              |
| `--target agents` | `.agents/skills/ducktective` in the current repo                           |
| `--dest <dir>`    | anywhere else — Cursor, Copilot, Gemini CLI, anything reading a `SKILL.md` |

The installer copies `SKILL.md`, the case-file schema, and `scripts/` — never the tests or
itself. It **refuses to overwrite a skill file you have edited** (`--force` to mean it),
`--dry-run` prints the plan, and re-running an unchanged install writes nothing.

Or as a Claude Code plugin, from this repo's own catalog:

```text
/plugin marketplace add adeerkhan/ducktective
/plugin install ducktective@ducktective
```

Manual: copy `SKILL.md`, `case-file.schema.json` and `scripts/` into your agent's skill
folder. Take all three — a `SKILL.md` without its scripts is the rules as advice again.

**Requirements:** Node 20.19+ (declared as `engines`, so `npm install` tells you). The
corpus needs Python for its cases; the gate itself drives any test runner, because `--cmd`
is just a shell command.

---

## What you type → what happens

You hand it a failing command. It runs that command before it thinks.

```
$ Ducktective, investigate this failing test.

node scripts/reproduce.mjs --cmd "python -m unittest -q test_totals" \
  --symptom "totals drop the last row" --out .ducktective/draft.json
→ exit 0 · reproduced in 106 ms · nearest fault: app.py:7 total()
```

If the symptom does not occur, it stops there — no candidates, no theory, no patch:

```
node scripts/reproduce.mjs --cmd "python -m unittest -q test_dnr" --symptom "…"
→ exit 1 · does_not_reproduce · 0 candidates
```

Then each candidate is stated as a hypothesis and tested with the smallest check that could
**disprove** it. The tool runs the check and decides the verdict by arithmetic, not by
asking the model whether it worked:

```
node scripts/run_check.mjs --file .ducktective/draft.json --candidate 1 \
  --hypothesis "end defaults to len(rows)-1, so rows[end + 1] is one past the end" \
  --predict fail --cmd "python -c \"from app import total; total([1, 2, 3])\"" \
  --control "python -c \"from app import total; total([1, 2, 3], 0, 1)\"" --yes
→ exit 0 · verdict confirmed · predicted fail · check exit 1 · control exit 0
```

Nothing executes until you pass `--yes`. The check is a model-written command running
through your shell in your repo, so it is printed in full first and a dry run exits 3
without executing anything. This is not a sandbox.

---

## The loop

1. **Reproduce** — the hard gate. Run the exact command; capture exit code, output,
   traceback, and coverage if the repo produces it. No in-repo evidence → `error`. Symptom
   absent → `does_not_reproduce` and stop.
2. **Candidates** — deliberately cheap: traceback frames plus lines the failing run covered
   and a passing run did not. Capped at five, nearest fault first. No graph.
3. **Falsify** — one candidate at a time: a one-line hypothesis, the smallest executable
   check, a control that must pass, and what the check actually printed.
4. **Case file** — the product. A JSON line plus a Markdown mirror, written by a tool that
   refuses unearned verdicts.
5. **Memory** — the store is per-repo, and the next investigation asks it what has already
   been tried.

---

## The tools

Four scripts, zero dependencies, plain `node`. Any agent that can run a shell command can
use them directly.

**`reproduce.mjs`** — the gate. Runs the command, parses the traceback, seeds candidates.
`0` reproduced · `1` does not reproduce (**stop**) · `2` the command never ran.

**`query_memory.mjs`** — the rap sheet: nearest past cases by keyword overlap. No
embeddings, no server. `0` always (an empty store is a normal day) · `2` bad args.

**`run_check.mjs`** — executes the oracle and decides `confirmed`/`falsified` from
`--predict` against the real exit code. `--control` proves the check can distinguish
anything; `--escalate` and `--depth 1` govern whether a second candidate may be touched;
`--verify` re-runs a decided claim in a new process and records whether it survived.
`0` recorded · `1` refused · `2` not evaluable · `3` dry run.

**`write_case.mjs`** — the store, and the enforcement point.
`0` stored · `1` refused · `2` bad input.

### What `write_case.mjs` refuses

The discipline has to survive the model that runs it, so these are type errors rather than
advice:

- a `confirmed` or `falsified` verdict with no captured output, or with no recorded exit
  code — that is, **a verdict typed by hand**
- a verdict that contradicts its own check (`predicted pass, exit 1 ⇒ falsified`)
- candidates on a case that did not reproduce
- a control command that also failed — a check that breaks everywhere distinguishes nothing
- `high`/`medium` confidence, a `confirmed_cause`, or a patch suggestion before the status
  is `confirmed`
- a case id that would escape the store directory, and any field the schema doesn't have

### What is deliberately _not_ here

No custom call graph, no multi-hop suspicion scoring, no multi-agent detective roles, no
knowledge-graph server, no required embeddings, no background scanning, no leaderboard
claims. Graph-guided fault localization is published and solved; the step almost every
agent still skips is _verifying that it is right_. If you want structural context, call
`tree-sitter` (or `graphify`) once, use it to rank, and throw it away.

---

## A case file

`write_case.mjs` writes `.ducktective/cases.jsonl` (one line per case, updated in place)
and `.ducktective/cases/<id>.md` for humans. This one is real output from the tools,
trimmed for width, against a self-authored fixture:

```markdown
# DT-260914-6dc0aa — totals drop the last row

**Status:** `confirmed` · **Confidence:** high · **Opened:** 2026-09-14T15:35:49Z
**Reproduction:** `python -m unittest -q test_totals` → `reproduced` in 106 ms (exit 1)

### 1. `app.py:7 total()` — confirmed

_Hypothesis:_ end defaults to len(rows)-1, so rows[end + 1] is always one past the last index
python -c "from app import total; total([1, 2, 3])"
_Evidence:_ check: exit 1 in 73 ms
IndexError: list index out of range
control: exit 0 in 40 ms

**Confirmed cause:** app.py:7 — with end defaulting to len(rows)-1, rows[end+1] is
always one past the last index
```

The JSONL is machine-readable on purpose: another skill can read the same file. Open one in
the browser at [`/cases`](https://adeerkhan.github.io/ducktective/cases) — it parses
locally and nothing is uploaded.

---

## How Ducktective differs from the neighbours

All of these are worth using; they answer different questions.

| Project                                                                                                                                      | What it is                                                                         | The difference                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Feynman](https://github.com/advaitpaliwal/feynman)                                                                                          | a research agent: papers, briefs, citations                                        | answers "what is known"; Ducktective answers "did you check"                                                |
| [humanizer](https://github.com/blader/humanizer)                                                                                             | a Markdown-only skill, no runtime                                                  | same portability bet; ours has executable tools because the claim needs an exit code                        |
| [agent-skills](https://github.com/addyosmani/agent-skills), [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | large skill collections — the latter documents 163 research skills, per its README | breadth is their asset; one narrow, enforced loop is the whole product here                                 |
| [autoprompt-skill](https://github.com/Spielewoy/autoprompt-skill)                                                                            | a skill that reports cutting agent failures by 45%                                 | same bet that a skill can be measured; Ducktective measures the _user's_ bugs, in your repo, on your runner |
| [semble](https://github.com/MinishLab/semble)                                                                                                | fast code search for agents                                                        | finds context cheaply — which is input to ranking, not a verdict                                            |
| SWE-agent · Agentless · AutoCodeRover · LocAgent                                                                                             | autonomous SWE pipelines                                                           | see [docs/ref-work.md](docs/ref-work.md) for the critique that motivated this design                        |

The published failure rate is the reason the gate exists: an agent that submits a patch it
cannot prove is not short of cleverness, it is short of a check.

---

## How it is checked

| Layer              | Command                          | What it can prove                                                                                                                                                        |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Guards             | `npm test`                       | prose cannot drift from code: one `SKILL.md`, schema↔site agreement, manifests↔README, the architecture doc kept true and _tracked_                                      |
| Unit + integration | `npm test`                       | frame order, the evidence rule, id containment, policy refusals, tree-kill, bounded capture, installer behaviour                                                         |
| Behaviour corpus   | `npm run eval`                   | the tools do what the docs say against real pytest/unittest/`node:test`/`coverage.py` runs — **self-authored cases**, so this is a regression net, not evidence of value |
| Run log            | `node evals/runlog.mjs --report` | whether it helps real bugs: M1–M9, each row tagged `real` or `constructed`                                                                                               |

Two rules hold this section together. A metric that nobody can record is a guess with a
name, so every metric in the plan has a column and an instrument. And an unrecorded answer
stays blank rather than defaulting to "no" — `no data [0/3]` and `0% [3/3]` are different
facts about the world, and confusing them is how a project appears to fail at something it
never ran.

**The kill criterion is public:** if nobody opens the case files — including the author —
then the differentiator is theoretical and this project should stop, or shrink to
reproduce-plus-case-file. Measuring that is the next work item, and it is a person's job,
not a feature's. See [design §8–§9](docs/ducktective-design.md).

---

## Repository layout

```
skills/ducktective/     the product
  SKILL.md              the whole contract, in one file
  case-file.schema.json shape of a case file (the site validates against it)
  scripts/              the four tools + lib/ (case file, exec, flag args)
  bin/install.mjs       the installer
  tests/                tool tests + Python and node:test fixtures
site/                   static marketing + demo (Vite, React, TanStack Router) → Pages
docs/                   design doc, architecture reference, prior-art critique
evals/                  behaviour corpus, runner, results, run ledger
scripts/                repo-level guards
.github/workflows/      deploy-site.yml (Pages), eval.yml (the corpus)
ref/                    gitignored research clones, never imported
```

`skills/` and `site/` are peers. The site is a _presentation_ of the skill: it imports the
same `SKILL.md` rather than pasting a copy, and a guard fails the build if the two diverge.

## Development

```bash
npm install        # once, at the root (npm workspaces → site/)
npm run dev        # http://localhost:8080/ducktective/
npm test           # guards + the skill's tool tests
npm run eval       # the behaviour corpus (needs pytest + coverage.py)
npm run build      # static output in site/dist, incl. 404.html + skill/SKILL.md
npm run typecheck && npm run lint
```

The site is static by design: GitHub Pages runs no server, so there is no server function,
no database, and no auth — the whole workbench executes in the browser. `SITE_BASE`
overrides the deploy prefix.

---

## FAQ

**Does it fix the bug?** No. It stops at a confirmed cause and labels any patch suggestion
secondary. Fixing is the host agent's job.

**Why isn't it an MCP server?** A server is a daemon, a port, and a lifecycle. A skill that
shells out works in every agent that can run `python -m pytest`, and its output is a file
you can `grep`.

**Why does `run_check` need `--yes`?** Because the check is a model-authored command run
through your shell in your repo. A denylist would be theatre — any `&&` defeats it — so you
see the exact command and approve it instead.

**What if the real fault is in a dependency?** The gate reports `error` with the reason
rather than inventing a reproduction, and ranks out-of-repo frames last. `--depth 1` plus a
human is the honest answer for that case.

**Which runners are supported?** Any command. Parse-verified today: pytest,
`python -m unittest`, plain Python scripts, `node --test`, plain `node`. Coverage:
`coverage.py` JSON, with `--baseline` for the fail-only signal.

**Will it help on a repo I can't run?** No, and it will tell you so. It targets code you can
actually execute.

**Why is the honesty so aggressive?** Because the failure being fixed is an unearned
confident claim. A README that oversold this tool would be the product's own bug, in the one
place nobody runs a test.

---

## Prior art and sources

The design came out of reading published agent pipelines and their measured results;
[docs/ref-work.md](docs/ref-work.md) is the full critique. Figures quoted on the
[`/protocol`](https://adeerkhan.github.io/ducktective/protocol) page carry a source and a
check date — e.g. arXiv:2603.25764 (a SWE-bench-style study where submissions reached 100%
while resolution sat near 44%, with most failures silent and semantic) and arXiv:2503.09089
(LocAgent, Acc@5 ≤ 92.7% on SWE-Bench-**Lite**) — both verified 2026-09-12. Star counts
there are a dated snapshot and expected to go stale.

## Contributing

Issues and PRs welcome, and the most useful contribution is a failing command from a repo
you can run. The rules live in
[`skills/ducktective/SKILL.md`](skills/ducktective/SKILL.md), which is the only copy in the
repo — a test refuses a second one.

## License

MIT — see [LICENSE](LICENSE).
