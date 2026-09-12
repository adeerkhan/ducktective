# Ducktective

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Deploy site](https://github.com/adeerkhan/ducktective/actions/workflows/deploy-site.yml/badge.svg)](https://github.com/adeerkhan/ducktective/actions/workflows/deploy-site.yml)
[![Skill stress run](https://github.com/adeerkhan/ducktective/actions/workflows/eval.yml/badge.svg)](evals/RESULTS.md)
[![Agent Skills](https://img.shields.io/badge/Standard-Agent_Skills-blueviolet.svg)](https://agentskills.io/)
[![Node](https://img.shields.io/badge/Node-20.19%2B-green.svg)](skills/ducktective/scripts)

**No claim without a check.** Ducktective is an [Agent Skill](https://agentskills.io/) that stops a coding agent from producing a confident, plausible, _wrong_ root cause. It forces reproduction first, forces an executable falsifying check for every candidate, and leaves a structured case file that a human can read in 30 seconds.

It is a contract the host agent is walked through, not a runtime. It does not index your repo, does not run a server, and does not need an API key.

```
Ducktective, investigate this failing test.
```

**Site:** <https://adeerkhan.github.io/ducktective/> · **Skill:** [`skills/ducktective/SKILL.md`](skills/ducktective/SKILL.md) · **Design:** [`docs/ducktective-design.md`](docs/ducktective-design.md)

---

## Installation

From a clone of this repo — one command, no dependencies beyond Node:

```bash
git clone https://github.com/adeerkhan/ducktective && cd ducktective
node skills/ducktective/bin/install.mjs --target claude
```

| Target            | Installs to                                                                             |
| ----------------- | --------------------------------------------------------------------------------------- |
| `--target claude` | `~/.claude/skills/ducktective`                                                          |
| `--target codex`  | `~/.codex/skills/ducktective`                                                           |
| `--target agents` | `.agents/skills/ducktective` in the current repo                                        |
| `--dest <dir>`    | anywhere else — Cursor, Copilot, Gemini CLI, OpenClaw, anything that reads a `SKILL.md` |

It copies `SKILL.md`, the case-file schema, and the four scripts — never the tests or the installer itself — and it **refuses to overwrite a skill file you have edited** (`--force` to mean it). `--dry-run` prints the plan; re-running an unchanged install writes nothing.

Manual install: copy `skills/ducktective/SKILL.md`, `case-file.schema.json` and `scripts/` into the skill folder. Take all three — a `SKILL.md` without its scripts is the rules as advice again.

Reload the agent, then ask it to investigate something.

**Requirements:** Node 20.19+ — declared as `engines` in both package files, so `npm install` tells you. The scripts use only the standard library. The corpus is Python and `node:test`; the gate drives any test runner, because `--cmd` is just a shell command.

---

## What you type → what happens

You give it a failing command. It runs that command before it thinks.

```
$ Ducktective, investigate this failing test.

node scripts/reproduce.mjs --cmd "python -m unittest -q test_totals" \
  --symptom "totals drop the last row" --out .ducktective/draft.json
→ reproduced in 210 ms · exit 1 · nearest fault: app.py:7 total()
```

If the symptom does not occur, the investigation ends there — no candidates, no theory, no patch:

```
node scripts/reproduce.mjs --cmd "python -m unittest -q test_dnr" --symptom "totals drop the last row"
→ exit 1 · does_not_reproduce · 0 candidates
```

Then each candidate is stated as a hypothesis and tested with the smallest check that could **disprove** it. The tool runs the check and decides the verdict by arithmetic:

```
node scripts/run_check.mjs --file .ducktective/draft.json --candidate 1 \
  --hypothesis "end defaults to len(rows)-1, so rows[end + 1] is one past the end" \
  --predict fail --cmd "python -c \"from app import total; total([1,2,3,4])\"" \
  --control "python -c \"from app import total; total([1,2,3,4], 0, 2)\"" --yes
→ exit 0 · {"verdict":"confirmed","predicted":"fail","check_exit_code":1,"control_exit_code":0}
```

Nothing executes until you pass `--yes`: the check is a model-written command in your repo, and it is printed in full first.

---

## The loop

1. **Reproduce** — hard gate. Run the exact failing command; capture exit, stdout, stderr, traceback, coverage. No reproduction → `does_not_reproduce` and stop.
2. **Candidates** — deliberately cheap: stack frames plus lines the failing run covered and no passing run covered. Hard cap of 5, nearest fault first. No graph.
3. **Falsify** — for one candidate: a one-line hypothesis, the smallest executable check, and what the check actually printed. Oracle held → falsified, demote. Oracle broke as predicted → confirmed, stop.
4. **Case file** — the product. JSON object plus a Markdown mirror.
5. **Memory** — the store is per-repo; the next investigation starts by asking it what it already knows.

---

## The tools

Zero dependencies, plain `node`, usable by any agent that can run a shell command.

| Tool               | Job                                                                                                                                                                            | Exit codes                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `reproduce.mjs`    | The gate. Runs the command, parses the traceback, seeds candidates.                                                                                                            | `0` reproduced · `1` does not reproduce (**stop**) · `2` the command never ran |
| `query_memory.mjs` | The rap sheet: nearest past cases by keyword overlap. No embeddings, no server.                                                                                                | `0` always (an empty store is a normal day) · `2` bad args                     |
| `run_check.mjs`    | Executes the oracle and decides `confirmed`/`falsified` from `--predict` vs the real exit code. An `inconclusive` candidate does not unlock the next one without `--escalate`. | `0` recorded · `1` refused · `2` not evaluable · `3` dry run                   |
| `write_case.mjs`   | The store, and the enforcement point.                                                                                                                                          | `0` stored · `1` refused · `2` bad input                                       |

### What `write_case.mjs` refuses

So the discipline survives the model that runs it, these are type errors rather than advice:

- a `confirmed` or `falsified` verdict with no captured output, or with no recorded exit code — i.e. **a verdict typed by hand**
- a verdict that contradicts its own check (`predicted pass, exit 1 ⇒ falsified`)
- candidates on a case that did not reproduce
- a control command that also failed — a check that breaks everywhere distinguishes nothing
- `high`/`medium` confidence, a `confirmed_cause`, or a patch suggestion before the status is `confirmed`
- more than five candidates; any field the schema doesn't have

### What is deliberately _not_ here

No custom call graph or `DuckGraph`, no multi-hop suspicion scoring, no multi-agent detective roles, no knowledge-graph server, no embeddings required, no background scanning, no leaderboard claims. Graph-guided localization is already solved and published; Ducktective is the verification layer almost every agent still treats as optional. If you want structural context, call `tree-sitter` (or `graphify`) once and throw the result away after ranking.

---

## A case file

`write_case.mjs` writes `.ducktective/cases.jsonl` (one line per case) and `.ducktective/cases/<id>.md` for humans:

```markdown
# DT-260912-c1fb47 — total() raises IndexError on a full-length list

**Status:** `confirmed` · **Confidence:** high
**Reproduction:** `python -m unittest -q test_totals` → `reproduced` in 210 ms (exit 1)

## Candidates

### 1. `app.py:7 total()` — confirmed

_Why:_ appears in the failing traceback
_Hypothesis:_ end defaults to len(rows)-1, so rows[end + 1] is one past the end
oracle: predicted fail → exit 1 · control exit 0
**Evidence:** IndexError: list index out of range (verbatim, from the run)

## Finding

**Confirmed cause:** app.py:7 — with end defaulting to len(rows)-1, rows[end + 1]
is always one past the last index
```

The JSONL is machine-readable on purpose: another skill can read the same file. Open one in the browser at [`/cases`](https://adeerkhan.github.io/ducktective/cases) — it parses locally, nothing is uploaded.

---

## Measurements

`npm run eval` runs a behaviour corpus of 12 cases against real pytest, unittest, plain Python scripts, `node:test`, and a real `coverage.py` diff. Details in [`evals/RESULTS.md`](evals/RESULTS.md).

| Metric                                                    | Result    |
| --------------------------------------------------------- | --------- |
| Stale or broken commands stopped before any investigation | **6/6**   |
| Nearest-fault ranked above its caller                     | **6/6**   |
| Cases behaving exactly as specified                       | **12/12** |

Two numbers the corpus cannot produce — tokens per investigation versus a plain "fix this" prompt, and whether a human keeps opening the case files — need a host agent and a person, so they are open questions rather than claims.

---

## Repository layout

```
skills/ducktective/     the product
  SKILL.md              the whole contract, in one file
  case-file.schema.json shape of a case file (the site validates against it)
  scripts/              the four tools + lib/
  bin/install.mjs       one-command install
  tests/                tool tests + a Python and a node:test fixture
site/                   static marketing + demo (Vite, React, TanStack Router) → GitHub Pages
docs/                   the design doc and the reference/critique review
evals/                  behaviour corpus, runner, results
scripts/                repo-level guards (layout, schema↔site agreement)
.github/workflows/      deploy-site.yml (Pages), eval.yml (the corpus)
ref/                    gitignored research clones, never imported
```

## Development

```bash
npm install        # once, at the root (npm workspaces → site/)
npm run dev        # http://localhost:8080/ducktective/
npm test           # guards + the skill's tool tests
npm run eval       # the behaviour corpus (needs pytest + coverage.py)
npm run build      # static output in site/dist, incl. 404.html + skill/SKILL.md
npm run typecheck && npm run lint
```

The site is static by design: GitHub Pages runs no server, so there is no server function, no database, no auth. The workbench demo executes in the browser. `SITE_BASE` overrides the deploy prefix.

## FAQ

**Does it fix the bug?** No. It stops at a confirmed cause and labels any patch suggestion secondary. Fixing is the host's job.

**Why isn't it an MCP server?** A server is a daemon, a port, and a lifecycle. A skill that shells out works in every agent that can run `python -m pytest`, and the case file is a file you can `grep`.

**Why does `run_check` need `--yes`?** Because the check is a model-authored command run through your shell in your repo. A denylist would be theatre — any `&&` defeats it — so instead you see the exact command and approve it.

**What if the real fault is in a dependency?** The gate reports `error` with the reason rather than inventing a reproduction, and ranks out-of-repo frames last. Read the traceback; that case is what `--max-candidates 1` and a human are for.

**Which runners are supported?** Any command. Parse-verified today: pytest, `python -m unittest`, plain Python scripts, `node --test`, plain `node`. Coverage: `coverage.py` JSON, with `--baseline` for the fail-only signal.

**Will it help on a repo I can't run?** No, and it will tell you so. It targets small-to-medium repos you can actually execute.

## Contributing

Issues and PRs welcome — especially failing commands from repos you can run, and real measurements for the two open metrics. The rules live in [`skills/ducktective/SKILL.md`](skills/ducktective/SKILL.md); `SKILL.md` is the only copy in the repo and a test refuses a second one.

## License

MIT — see [LICENSE](LICENSE).
